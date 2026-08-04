import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  PayloadTooLargeException,
} from '@nestjs/common';
import type { PatrolRules } from '@voxia/shared';
import { plainToInstance, type ClassConstructor } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { CreateScanDto } from '../guard/dto/create-scan.dto';
import { ReportEventDto } from '../guard/dto/report-event.dto';
import { GuardService } from '../guard/guard.service';
import { RulesService } from '../rules/rules.service';
import { instanteConfiable, type MedicionDeReloj } from './device-clock';
import { esRondaCerrada, evaluarEscaneoAtrasado } from './late-scan.policy';
import {
  EscaneoAtrasadoError,
  SyncConflictsService,
  type DatosDeAtraso,
} from './sync-conflicts.service';
import type { PushBatchDto, SyncOperationDto } from './dto/push-batch.dto';

export type SyncOperationStatus = 'aplicado' | 'duplicado' | 'rechazado';

export interface SyncOperationResult {
  clientId: string;
  status: SyncOperationStatus;
  reason?: string;
  serverId?: string;
  /** Marca atrasada que quedo guardada, cuando la ronda ya estaba cerrada (#73). */
  lateScanId?: string;
}

interface Veredicto {
  status: SyncOperationStatus;
  reason?: string;
  serverId?: string;
  lateScanId?: string;
}

/** Lo que vale para TODO el lote: el reloj del equipo y las reglas del tenant. */
interface ContextoDeLote {
  readonly medicion: MedicionDeReloj | null;
  readonly reglas: PatrolRules;
}

/** Nombre fijo, nunca interpolado con datos del request. */
const SAVEPOINT = 'sync_op';

const MAX_REASON = 500;

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly guard: GuardService,
    private readonly rules: RulesService,
    private readonly conflicts: SyncConflictsService,
  ) {}

  /**
   * Sincronizacion en lote de lo que el dispositivo acumulo sin señal (#14).
   *
   * El requisito central: UNA operacion invalida no puede tumbar el lote. El
   * guardia no pierde 40 escaneos porque uno venia mal, asi que cada operacion
   * se procesa aislada y devuelve su propio veredicto.
   *
   * No reimplementa el escaneo ni el evento: delega en GuardService, que es
   * donde viven las anomalias, el cierre de ronda y las alertas.
   *
   * Reloj y conflictos (#73): el desfase del reloj se mide UNA vez por lote —es
   * del equipo, no de cada operacion— y el escaneo que llega sobre una ronda ya
   * cerrada se guarda como marca atrasada en vez de perderse.
   */
  async pushBatch(guardId: string, input: PushBatchDto) {
    // El limite es una regla de la empresa, no un numero de este archivo.
    const rules = await this.rules.effective();
    if (input.operations.length > rules.syncMaxBatchSize) {
      throw new PayloadTooLargeException(
        `El lote trae ${input.operations.length} operaciones y el maximo configurado ` +
          `para tu empresa es ${rules.syncMaxBatchSize}. Divide la cola en lotes mas ` +
          'chicos y reenviala: no se perdio ninguna operacion.',
      );
    }

    const contexto: ContextoDeLote = {
      reglas: rules,
      medicion: await this.medirReloj(guardId, input, rules),
    };

    // Una sola lectura para todo el lote: el reenvio completo de la cola no
    // vuelve a ejecutar nada, se responde desde la bitacora.
    const vistas = await this.leerBitacora(
      guardId,
      input.operations.map((operacion) => operacion.clientId),
    );

    const resultados: SyncOperationResult[] = [];
    const reenviadas: string[] = [];

    // Secuencial a proposito. Todo el request comparte UNA transaccion y UNA
    // conexion (TenantContextInterceptor), donde los SAVEPOINT solo tienen
    // sentido en serie; y ademas el orden importa: el escaneo del punto de
    // cierre cierra la ronda con lo que ya quedo escrito.
    for (const operacion of input.operations) {
      const previa = vistas.get(operacion.clientId);
      if (previa) {
        reenviadas.push(operacion.clientId);
        resultados.push({ clientId: operacion.clientId, ...this.respuestaDeReenvio(previa) });
        continue;
      }

      const veredicto = await this.procesar(guardId, operacion, contexto);
      // Un client_id repetido DENTRO del mismo lote se responde igual que un
      // reenvio: la cola del dispositivo puede traer duplicados propios.
      vistas.set(operacion.clientId, veredicto);
      resultados.push({ clientId: operacion.clientId, ...veredicto });
    }

    if (reenviadas.length) {
      // Tambien aislado: un contador de observabilidad no puede tumbar la
      // transaccion cuando el trabajo del guardia ya esta escrito.
      const conteo = await this.enSavepoint(() => this.contarReenvios(guardId, reenviadas));
      if (!conteo.ok) {
        this.logger.warn(JSON.stringify({ event: 'sync_conteo_reenvios_fallo' }));
      }
    }

    return {
      received: input.operations.length,
      summary: {
        aplicado: resultados.filter((r) => r.status === 'aplicado').length,
        duplicado: resultados.filter((r) => r.status === 'duplicado').length,
        rechazado: resultados.filter((r) => r.status === 'rechazado').length,
      },
      results: resultados,
      // Que la app sepa que su reloj esta corrido, y lo diga: la correccion la
      // hace el sistema igual, pero un telefono con la hora mala hay que
      // arreglarlo, no compensarlo para siempre.
      clock: contexto.medicion
        ? {
            offsetMs: contexto.medicion.offsetMs,
            toleranceMs: contexto.medicion.toleranciaMs,
            skewed: contexto.medicion.desfasado,
          }
        : null,
    };
  }

  /**
   * Observabilidad de la sincronizacion (#14). El dato que el supervisor no
   * tiene hoy es el TIEMPO SIN SEÑAL: sale de la diferencia entre la hora en que
   * el dispositivo encolo y la hora en que el servidor recibio.
   */
  async syncStatus(guardId: string) {
    const filas = await this.tenantContext.manager.query<
      Array<{
        aplicadas: number;
        duplicadas: number;
        rechazadas: number;
        reenvios: number;
        gap_max_s: number | null;
        gap_prom_s: number | null;
        ultima_sync: Date | null;
      }>
    >(
      `SELECT
         count(*) FILTER (WHERE status = 'aplicado')::int AS aplicadas,
         count(*) FILTER (WHERE status = 'duplicado')::int AS duplicadas,
         count(*) FILTER (WHERE status = 'rechazado')::int AS rechazadas,
         coalesce(sum(attempts - 1), 0)::int AS reenvios,
         -- Un telefono con el reloj adelantado daria una brecha negativa, que
         -- como "tiempo sin señal" no significa nada; el desfase ya se marca
         -- como anomalia en el escaneo.
         max(GREATEST(0, EXTRACT(EPOCH FROM (synced_at_server - queued_at_device))))::int
           AS gap_max_s,
         avg(GREATEST(0, EXTRACT(EPOCH FROM (synced_at_server - queued_at_device))))::int
           AS gap_prom_s,
         -- Fuera de la ventana: si el guardia lleva tres dias sin sincronizar,
         -- el dato que importa es justamente ese, y en 24h no aparece.
         (SELECT max(synced_at_server) FROM sync_operations WHERE guard_id = $1)
           AS ultima_sync
       FROM sync_operations
       WHERE guard_id = $1
         AND synced_at_server >= now() - interval '24 hours'`,
      [guardId],
    );

    // Agregacion sin GROUP BY: siempre devuelve exactamente una fila.
    const fila = filas[0]!;
    return {
      guardId,
      windowHours: 24,
      operations: {
        applied: fila.aplicadas,
        duplicated: fila.duplicadas,
        rejected: fila.rechazadas,
        retransmissions: fila.reenvios,
      },
      lastSyncedAt: fila.ultima_sync,
      offlineGapSeconds: { max: fila.gap_max_s, avg: fila.gap_prom_s },
    };
  }

  /**
   * Estado del reloj del guardia, para que la app avise ANTES de la ronda (#73).
   */
  async clockStatus(guardId: string) {
    const rules = await this.rules.effective();
    return this.conflicts.estadoDelReloj(guardId, rules.clockSkewToleranceMin);
  }

  /**
   * Mide el reloj del equipo una vez por lote. Aislado: perder la medicion
   * degrada la observabilidad, no el trabajo del guardia.
   */
  private async medirReloj(
    guardId: string,
    input: PushBatchDto,
    reglas: PatrolRules,
  ): Promise<MedicionDeReloj | null> {
    if (!input.deviceTime) return null;
    const medicion = await this.enSavepoint(() =>
      this.conflicts.medirReloj(
        guardId,
        input.deviceTime,
        reglas.clockSkewToleranceMin,
        input.operations.length,
      ),
    );
    if (!medicion.ok) {
      this.logger.warn(JSON.stringify({ event: 'sync_medicion_reloj_fallo' }));
      return null;
    }
    return medicion.value;
  }

  private async procesar(
    guardId: string,
    operacion: SyncOperationDto,
    contexto: ContextoDeLote,
  ): Promise<Veredicto> {
    const ejecucion = await this.enSavepoint(() => this.ejecutar(guardId, operacion, contexto));
    const fallo = ejecucion.ok ? null : ejecucion.error;
    let veredicto: Veredicto = ejecucion.ok
      ? ejecucion.value
      : { status: 'rechazado', reason: motivo(fallo) };

    // La marca que llego con la ronda ya cerrada NO se pierde (#73). Va DESPUES
    // de soltar el savepoint por lo mismo que la bitacora: adentro, el rollback
    // de la operacion rechazada se llevaria tambien esta fila.
    if (fallo instanceof EscaneoAtrasadoError) {
      const lateScanId = await this.guardarAtrasado(fallo.datos, operacion.type);
      if (lateScanId) veredicto = { ...veredicto, lateScanId };
    }

    // El registro va DESPUES de soltar el savepoint: adentro, el rollback de la
    // operacion invalida se llevaria tambien la fila que explica su rechazo.
    const registro = await this.enSavepoint(() => this.registrar(guardId, operacion, veredicto));
    if (!registro.ok) {
      // La operacion ya se aplico; perder su fila de bitacora degrada la
      // observabilidad, no el trabajo del guardia. Sin datos de personas.
      this.logger.warn(JSON.stringify({ event: 'sync_bitacora_fallo', kind: operacion.type }));
    }
    return veredicto;
  }

  /**
   * Guarda la marca atrasada en su propio savepoint. Perder el anexo degrada la
   * revision del supervisor, no el resto del lote, asi que no puede tumbarlo.
   */
  private async guardarAtrasado(
    datos: DatosDeAtraso,
    kind: SyncOperationDto['type'],
  ): Promise<string | null> {
    const anexo = await this.enSavepoint(() => this.conflicts.registrarAtrasado(datos));
    if (!anexo.ok) {
      // Sin datos de personas: solo el tipo de operacion.
      this.logger.warn(JSON.stringify({ event: 'sync_atrasado_no_guardado', kind }));
      return null;
    }
    return anexo.value;
  }

  /**
   * Aisla una operacion del resto del lote.
   *
   * Sin el savepoint esto no funciona: un error de PostgreSQL aborta LA
   * transaccion completa del request y toda consulta posterior falla con 25P02.
   * Un try/catch de JavaScript no revive una transaccion abortada — atraparia el
   * error y perderia igual las otras 39 operaciones.
   */
  private async enSavepoint<T>(
    operacion: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    await this.tenantContext.manager.query(`SAVEPOINT ${SAVEPOINT}`);
    try {
      const value = await operacion();
      await this.tenantContext.manager.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      return { ok: true, value };
    } catch (error) {
      await this.tenantContext.manager.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      // Se libera para no apilar un savepoint por operacion en un lote de 200.
      await this.tenantContext.manager.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
      return { ok: false, error };
    }
  }

  private ejecutar(
    guardId: string,
    operacion: SyncOperationDto,
    contexto: ContextoDeLote,
  ): Promise<Veredicto> {
    return operacion.type === 'scan'
      ? this.ejecutarEscaneo(guardId, operacion, contexto)
      : this.ejecutarEvento(guardId, operacion);
  }

  private async ejecutarEscaneo(
    guardId: string,
    operacion: SyncOperationDto,
    contexto: ContextoDeLote,
  ): Promise<Veredicto> {
    if (!operacion.patrolId) {
      throw new BadRequestException('Una operacion de tipo scan necesita patrolId');
    }
    const payload = await this.validarPayload(CreateScanDto, {
      ...operacion.payload,
      clientScanId: this.claveDeIdempotencia(operacion, 'clientScanId'),
    });

    await this.verificarRondaCerrada(guardId, operacion.patrolId, payload, contexto);

    const resultado = await this.guard.registerScan(operacion.patrolId, guardId, payload);

    // Reloj fuera de tolerancia: se MARCA en el escaneo, no se descarta. La
    // hora cruda del telefono se conserva; lo que se guarda es con cuanto hay
    // que corregirla al leer.
    if (contexto.medicion?.desfasado) {
      await this.conflicts.marcarRelojDesfasado(
        operacion.patrolId,
        payload.clientScanId,
        contexto.medicion.offsetMs,
      );
    }

    return {
      status: resultado.replay ? 'duplicado' : 'aplicado',
      // registerScan no devuelve el id del escaneo y el dispositivo lo necesita
      // para colgarle la foto que tambien trae encolada.
      serverId: await this.idDelEscaneo(operacion.patrolId, payload.clientScanId),
    };
  }

  /**
   * Ronda ya cerrada: quien gana lo decide late-scan.policy.ts (#73).
   *
   * Se consulta ANTES de delegar porque registerScan contesta 409 y no deja
   * rastro del escaneo: el guardia perderia una ronda entera hecha en un
   * subterraneo solo porque la ronda vencio mientras no tenia señal.
   *
   * Si la ronda no existe o no es de este guardia, esto no decide nada: deja
   * que registerScan conteste su 404 y no duplica la semantica del error.
   */
  private async verificarRondaCerrada(
    guardId: string,
    patrolId: string,
    payload: CreateScanDto,
    contexto: ContextoDeLote,
  ): Promise<void> {
    const ronda = await this.conflicts.rondaDeLaOperacion(patrolId, guardId);
    if (!ronda || !esRondaCerrada(ronda.status)) return;
    const estado = ronda.status;

    // El instante que se compara es el CORREGIDO por el desfase del reloj: con
    // la hora cruda bastaria con atrasar el telefono para que todo escaneo
    // pareciera hecho a tiempo.
    const instante = instanteConfiable({
      deviceAt: payload.scannedAt,
      serverAt: ronda.serverNow,
      medicion: contexto.medicion,
    });

    const veredicto = evaluarEscaneoAtrasado(
      {
        status: estado,
        closedAt: ronda.closedAt,
        scheduledEndAt: ronda.scheduledEndAt,
      },
      instante.at,
      contexto.reglas.lateScanGraceMin,
    );

    throw new EscaneoAtrasadoError(veredicto, {
      patrolId,
      guardId,
      clientScanId: payload.clientScanId,
      tagUid: payload.uid.trim(),
      method: payload.method,
      patrolStatus: estado,
      clasificacion: veredicto.clasificacion,
      minutosDeAtraso: veredicto.minutosDeAtraso,
      graciaMin: contexto.reglas.lateScanGraceMin,
      scannedAtDevice: payload.scannedAt ?? null,
      scannedAtEffective: instante.at,
      fuenteDelInstante: instante.fuente,
      clockOffsetMs: contexto.medicion ? contexto.medicion.offsetMs : null,
      latitude: payload.latitude ?? null,
      longitude: payload.longitude ?? null,
      accuracyM: payload.accuracyM ?? null,
    });
  }

  private async ejecutarEvento(guardId: string, operacion: SyncOperationDto): Promise<Veredicto> {
    const payload = await this.validarPayload(ReportEventDto, {
      ...operacion.payload,
      clientEventId: this.claveDeIdempotencia(operacion, 'clientEventId'),
      ...(operacion.patrolId ? { patrolId: operacion.patrolId } : {}),
    });

    const resultado = await this.guard.reportEvent(guardId, payload);
    return {
      status: resultado.replay ? 'duplicado' : 'aplicado',
      serverId: resultado.id,
    };
  }

  /**
   * El clientId del sobre y la clave del payload tienen que ser la MISMA. Si
   * divergieran, la bitacora daria la operacion por guardada y la tabla de
   * destino la insertaria de nuevo en cada reenvio.
   */
  private claveDeIdempotencia(
    operacion: SyncOperationDto,
    campo: 'clientScanId' | 'clientEventId',
  ): string {
    const enPayload = operacion.payload[campo];
    if (enPayload !== undefined && enPayload !== operacion.clientId) {
      throw new BadRequestException(
        `El ${campo} del payload no coincide con el clientId de la operacion`,
      );
    }
    return operacion.clientId;
  }

  /** Misma politica que el pipe global, pero por operacion y sin tumbar el lote. */
  private async validarPayload<T extends object>(
    tipo: ClassConstructor<T>,
    payload: object,
  ): Promise<T> {
    const instancia = plainToInstance(tipo, payload);
    const errores = await validate(instancia, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    if (errores.length) {
      throw new BadRequestException(`Payload invalido: ${resumirErrores(errores)}`);
    }
    return instancia;
  }

  private async idDelEscaneo(patrolId: string, clientScanId: string) {
    const filas = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `SELECT id FROM scans WHERE patrol_id = $1 AND client_scan_id = $2`,
      [patrolId, clientScanId],
    );
    return filas[0]?.id;
  }

  private async leerBitacora(guardId: string, clientIds: readonly string[]) {
    const filas = await this.tenantContext.manager.query<
      Array<{
        client_id: string;
        status: SyncOperationStatus;
        reason: string | null;
        server_id: string | null;
      }>
    >(
      `SELECT client_id, status, reason, server_id
       FROM sync_operations
       WHERE guard_id = $1 AND client_id = ANY($2::uuid[])`,
      [guardId, [...clientIds]],
    );

    return new Map<string, Veredicto>(
      filas.map((fila): [string, Veredicto] => [
        fila.client_id,
        {
          status: fila.status,
          ...(fila.reason ? { reason: fila.reason } : {}),
          ...(fila.server_id ? { serverId: fila.server_id } : {}),
        },
      ]),
    );
  }

  /**
   * Un reenvio suma intento y NO mueve synced_at_server: esa marca es la hora en
   * que la operacion llego por primera vez, y es la que sostiene la metrica de
   * tiempo sin señal.
   */
  private async contarReenvios(guardId: string, clientIds: readonly string[]) {
    await this.tenantContext.manager.query(
      `UPDATE sync_operations
       SET attempts = attempts + 1
       WHERE guard_id = $1 AND client_id = ANY($2::uuid[])`,
      [guardId, [...clientIds]],
    );
  }

  private async registrar(
    guardId: string,
    operacion: SyncOperationDto,
    veredicto: Veredicto,
  ) {
    await this.tenantContext.manager.query(
      `INSERT INTO sync_operations (
         tenant_id, guard_id, client_id, kind, status, reason, server_id, queued_at_device
       ) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tenant_id, guard_id, client_id) DO NOTHING`,
      [
        guardId,
        operacion.clientId,
        operacion.type,
        veredicto.status,
        veredicto.reason ?? null,
        veredicto.serverId ?? null,
        operacion.queuedAt,
      ],
    );
  }

  /**
   * Lo ya registrado no se reprocesa. Un rechazo se sigue respondiendo
   * 'rechazado': si contestaramos 'duplicado', el dispositivo borraria de su
   * cola algo que nunca se guardo y el escaneo se perderia en silencio.
   */
  private respuestaDeReenvio(previa: Veredicto): Veredicto {
    return previa.status === 'rechazado' ? previa : { ...previa, status: 'duplicado' };
  }
}

/**
 * El motivo viaja al dispositivo y queda en la bitacora. Los errores nuestros
 * (NotFound, Conflict, validacion) son texto pensado para el guardia; cualquier
 * otro se generaliza, porque un error crudo de PostgreSQL puede arrastrar datos
 * de la fila.
 */
function motivo(error: unknown): string {
  if (error instanceof HttpException) {
    const respuesta = error.getResponse();
    const mensaje =
      typeof respuesta === 'string'
        ? respuesta
        : (respuesta as { message?: string | string[] }).message;
    const texto = Array.isArray(mensaje) ? mensaje.join('; ') : (mensaje ?? error.message);
    return texto.slice(0, MAX_REASON);
  }
  return 'La operacion no se pudo aplicar en el servidor';
}

function resumirErrores(errores: readonly ValidationError[]): string {
  return errores
    .map((error) => Object.values(error.constraints ?? {}).join('; ') || error.property)
    .join(' | ')
    .slice(0, 300);
}
