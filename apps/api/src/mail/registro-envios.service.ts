import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { MAIL_JOB_ATTEMPTS } from './mail-queue.constants';
import type { MailDelivery } from './mail-provider';
import type { MailJobData } from './mail-queue.types';
import {
  MOTIVO_MAX_LARGO,
  PLANTILLA_DESCONOCIDA,
  REGISTRO_LIMITE_DEFECTO,
  REGISTRO_LIMITE_MAXIMO,
} from './registro-envios.constants';
import { RegistroCorrelacionService } from './registro-envios.correlacion';
import type {
  DatosRegistroEnvio,
  EnvioRegistrado,
  EstadoEnvio,
  EventoEntrega,
  FiltroRegistro,
  JobDeCorreo,
  ResultadoEvento,
} from './registro-envios.types';

/**
 * Registro de envios de correo y estado por notificacion (#44).
 *
 * QUE RESPONDE
 * "¿Le llego el informe al cliente?" — y las tres respuestas honestas que ese
 * "si" esconde: se encolo, el servidor lo acepto, el proveedor confirmo que
 * entro al buzon. Antes de este registro el producto solo sabia lo primero, y
 * solo para el informe de ronda.
 *
 * DONDE SE ENGANCHA
 *   - `registrarEncolado()` lo llama MailQueueService al aceptar el correo.
 *   - `registrarEnviado()` / `registrarFallido()` los llama MailProcessor cuando
 *     el proveedor SMTP acepta o rechaza el mensaje.
 *   - `aplicarEventoProveedor()` lo llama el webhook de estado de entrega.
 * Los tres enganches estan escritos, con el parche exacto, en INTEGRACION.md.
 *
 * POR QUE LOS TRES PRIMEROS ABREN SU PROPIA TRANSACCION
 * Y no aprovechan la del request: el correo YA se encolo en Redis, y Redis no
 * participa de la transaccion de nadie. Si el registro viviera dentro de la
 * transaccion del negocio, un rollback dejaria un correo enviado que ninguna
 * fila registra — que es exactamente el agujero que este issue viene a tapar.
 * El registro cuenta lo que hizo el sistema de correo, no lo que decidio el
 * negocio.
 *
 * Ademas, el processor de BullMQ no tiene request ni contexto de tenant, asi que
 * necesita abrir la transaccion igual. `enTenant()` setea `app.tenant_id` con
 * `set_config(..., true)` — que es SET LOCAL: muere con la transaccion y no se
 * pega a la conexion del pool para el siguiente job.
 *
 * NINGUNA DE LAS TRES ESCRITURAS PUEDE ROMPER UN CORREO. Si el registro falla,
 * se anota en el log y el envio sigue: un informe que no sale es peor que un
 * informe que sale sin quedar registrado. Por eso capturan su propio error en
 * vez de propagarlo al llamador.
 */
@Injectable()
export class RegistroEnviosService {
  private readonly logger = new Logger(RegistroEnviosService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly tenantContext: TenantContextService,
    private readonly correlacion: RegistroCorrelacionService,
  ) {}

  // ---------------------------------------------------------------- escritura

  /**
   * Deja la fila del correo al momento de encolarlo, en estado 'encolado'.
   *
   * Devuelve el id de la fila, o null cuando no habia nada que registrar. Los
   * correos SIN tenant no se registran: la tabla es de negocio y lleva
   * `tenant_id NOT NULL`, y una recuperacion de clave de un SUPERADMIN no
   * pertenece a ninguna empresa. Quedan cubiertos por el log de la cola, no por
   * este registro; esta escrito asi en INTEGRACION.md para que no se descubra
   * mirando una fila que falta.
   */
  async registrarEncolado(
    data: MailJobData,
    jobId: string,
    registro?: DatosRegistroEnvio,
  ): Promise<string | null> {
    if (data.tenantId === null) return null;

    const destinatario = normalizarCorreo(data.to);
    if (destinatario.indexOf('@') < 1) {
      // Espejo del CHECK de la tabla: si no calza, la fila no entra y lo que se
      // pierde es el registro entero. Mejor detectarlo aca y decirlo.
      this.logger.warn(
        JSON.stringify({
          event: 'registro_envio_destinatario_invalido',
          tenant_id: data.tenantId,
          job_id: jobId,
        }),
      );
      return null;
    }

    const plantilla = normalizarPlantilla(registro?.plantilla) ?? PLANTILLA_DESCONOCIDA;

    try {
      return await this.enTenant(data.tenantId, async (manager) => {
        const filas = await manager.query<Array<{ id: string }>>(
          `INSERT INTO mail_deliveries (
            tenant_id, template_key, recipient_email, recipient_user_id, patrol_id, job_id
          ) VALUES (app_tenant_id(), $1, $2, $3, $4, $5)
          ON CONFLICT (tenant_id, job_id) DO NOTHING
          RETURNING id`,
          [
            plantilla,
            destinatario,
            registro?.usuarioId ?? null,
            registro?.patrolId ?? null,
            jobId,
          ],
        );
        // INSERT ... RETURNING devuelve las filas planas. Son UPDATE y DELETE
        // los que devuelven [filas, cantidad]; ver resultadoDeEscritura().
        return filas[0]?.id ?? null;
      });
    } catch (error) {
      this.anotarFallaDeRegistro('registro_envio_no_encolado', data.tenantId, jobId, error);
      return null;
    }
  }

  /**
   * El servidor SMTP acepto el mensaje.
   *
   * Guarda ademas el Message-ID en el indice de correlacion: es lo unico con lo
   * que el webhook del proveedor va a poder encontrar esta fila mas tarde.
   */
  async registrarEnviado(job: JobDeCorreo, entrega: MailDelivery): Promise<void> {
    const tenantId = job.data.tenantId;
    const jobId = job.id;
    if (tenantId === null || !jobId) return;

    const intentos = job.attemptsMade + 1;
    const messageId = entrega.messageId.trim();

    try {
      const registroId = await this.enTenant(tenantId, async (manager) => {
        const crudo = await manager.query<unknown>(
          `UPDATE mail_deliveries
           SET status = 'enviado',
               sent_at = COALESCE(sent_at, now()),
               attempts = $3,
               provider_message_id = $2,
               last_error = NULL
           WHERE tenant_id = app_tenant_id() AND job_id = $1 AND status = 'encolado'
           RETURNING id`,
          [jobId, messageId.length === 0 ? null : messageId, intentos],
        );
        const { filas } = resultadoDeEscritura<{ id: string }>(crudo);
        return filas[0]?.id ?? null;
      });

      if (registroId === null) {
        // Sin fila que actualizar: el correo salio igual. Pasa cuando el envio
        // no llego a registrarse al encolar (correo sin tenant, o el INSERT
        // fallo). Se anota porque significa un hueco en la auditoria.
        this.logger.warn(
          JSON.stringify({
            event: 'registro_envio_sin_fila',
            tenant_id: tenantId,
            job_id: jobId,
          }),
        );
        return;
      }

      if (messageId.length > 0) {
        await this.correlacion.recordar(messageId, { tenantId, registroId });
      }
    } catch (error) {
      this.anotarFallaDeRegistro('registro_envio_no_marcado', tenantId, jobId, error);
    }
  }

  /**
   * El intento fallo.
   *
   * Mientras queden reintentos la fila sigue 'encolado' y solo se actualizan el
   * contador y el motivo: darla por fallida en el primer tropiezo mostraria en
   * la vista de soporte un correo muerto que la cola va a entregar treinta
   * segundos despues.
   */
  async registrarFallido(job: JobDeCorreo, causa: unknown): Promise<void> {
    const tenantId = job.data.tenantId;
    const jobId = job.id;
    if (tenantId === null || !jobId) return;

    const intentos = job.attemptsMade + 1;
    const definitivo = intentos >= MAIL_JOB_ATTEMPTS;
    const motivo = sanearMotivo(causa);

    try {
      await this.enTenant(tenantId, async (manager) => {
        const crudo = await manager.query<unknown>(
          `UPDATE mail_deliveries
           SET attempts = $2,
               last_error = $3,
               status = CASE WHEN $4 THEN 'fallido' ELSE status END,
               failed_at = CASE WHEN $4 THEN COALESCE(failed_at, now()) ELSE failed_at END
           WHERE tenant_id = app_tenant_id() AND job_id = $1
           RETURNING id`,
          [jobId, intentos, motivo, definitivo],
        );
        return resultadoDeEscritura<{ id: string }>(crudo).filas.length;
      });
    } catch (error) {
      this.anotarFallaDeRegistro('registro_envio_no_fallado', tenantId, jobId, error);
    }
  }

  /**
   * Estado de entrega reportado por el proveedor.
   *
   * A diferencia de los tres de arriba, este SI propaga el error: lo llama un
   * endpoint HTTP que tiene que responder con un codigo honesto y, si el
   * proveedor reintenta, conviene que reintente.
   *
   * El tenant NO viene en la peticion: sale del indice de correlacion que dejo
   * `registrarEnviado()`. Ver registro-envios.correlacion.ts para por que esa
   * busqueda no puede hacerse en SQL sin abrir un agujero en RLS.
   */
  async aplicarEventoProveedor(evento: EventoEntrega): Promise<ResultadoEvento> {
    const correlacion = await this.correlacion.resolver(evento.messageId);
    if (!correlacion) return { aplicado: false, ignorado: 'sin_correlacion' };

    const motivo = evento.motivo === undefined || evento.motivo === null
      ? null
      : sanearMotivo(evento.motivo);

    return this.enTenant(correlacion.tenantId, async (manager): Promise<ResultadoEvento> => {
      const crudo = await manager.query<unknown>(
        `UPDATE mail_deliveries
         SET status = $2,
             delivered_at = CASE
               WHEN $2 = 'entregado' THEN COALESCE(delivered_at, GREATEST(sent_at, $3::timestamptz))
               ELSE delivered_at
             END,
             failed_at = CASE
               WHEN $2 IN ('rebotado', 'reclamo') THEN COALESCE(failed_at, GREATEST(sent_at, $3::timestamptz))
               ELSE failed_at
             END,
             last_error = COALESCE($4::text, last_error)
         WHERE tenant_id = app_tenant_id()
           AND id = $1
           AND sent_at IS NOT NULL
           AND status <> $2
           AND status IN ('enviado', 'entregado')
         RETURNING id`,
        [correlacion.registroId, evento.evento, evento.ocurridoEn.toISOString(), motivo],
      );
      const { filas } = resultadoDeEscritura<{ id: string }>(crudo);

      if (filas.length > 0) {
        // Ni el correo ni el Message-ID: de que empresa es y en que quedo.
        this.logger.log(
          JSON.stringify({
            event: 'estado_entrega_aplicado',
            tenant_id: correlacion.tenantId,
            estado: evento.evento,
          }),
        );
        return { aplicado: true, ignorado: null };
      }

      // La fila existe (la correlacion la nombra) pero no admitia el cambio:
      // el mismo evento repetido, o uno que llego antes de registrar el envio.
      const existe = await manager.query<Array<{ status: string }>>(
        `SELECT status FROM mail_deliveries WHERE tenant_id = app_tenant_id() AND id = $1`,
        [correlacion.registroId],
      );
      return {
        aplicado: false,
        ignorado: existe.length === 0 ? 'sin_registro' : 'estado_no_aplica',
      };
    });
  }

  /**
   * Borra el registro mas viejo que `dias`.
   *
   * `dias` LLEGA POR PARAMETRO Y NO SE DECIDE ACA: es la regla configurable
   * `mailLogRetentionDays` (ver INTEGRACION.md). La fila guarda el correo de una
   * persona de contacto y cuanto se conserva es una politica de la empresa, no
   * una constante del producto.
   *
   * NO HAY CRON QUE LO LLAME TODAVIA, y es a proposito: un scheduler dentro de
   * la API corre en cada replica. Cuando exista, va como worker BullMQ repetible
   * — mismo criterio que `EscalationService.pendingEscalations()`.
   */
  async purgar(tenantId: string, dias: number): Promise<number> {
    if (!Number.isInteger(dias) || dias <= 0) {
      throw new BadRequestException('La retencion del registro debe ser un numero de dias');
    }

    return this.enTenant(tenantId, async (manager) => {
      const crudo = await manager.query<unknown>(
        `DELETE FROM mail_deliveries
         WHERE tenant_id = app_tenant_id()
           AND queued_at < now() - ($1::int * interval '1 day')`,
        [dias],
      );
      return resultadoDeEscritura<never>(crudo).cantidad;
    });
  }

  // ----------------------------------------------------------------- consulta

  /**
   * Que correos salieron por esta ronda y en que quedaron. Es la respuesta
   * directa al criterio de aceptacion del issue.
   *
   * El SUPERVISOR esta limitado a SUS recintos asignados: el permiso
   * `reports:read` por si solo no alcanza (ver CLAUDE.md y roles.ts).
   */
  async porRonda(
    patrolId: string,
    requester: Pick<AuthenticatedUser, 'sub' | 'role'>,
  ): Promise<{ patrolId: string; envios: EnvioRegistrado[] }> {
    const rondas = await this.tenantContext.manager.query<
      Array<{ site_id: string; status: string }>
    >(`SELECT site_id, status FROM patrols WHERE id = $1`, [patrolId]);
    const ronda = rondas[0];
    if (!ronda) throw new NotFoundException('La ronda no existe');
    await this.verificarAlcance(ronda.site_id, requester);

    const filas = await this.tenantContext.manager.query<FilaRegistro[]>(
      `SELECT id, template_key, recipient_email, recipient_user_id, patrol_id, status,
              attempts, last_error, queued_at, sent_at, delivered_at, failed_at
       FROM mail_deliveries
       WHERE tenant_id = app_tenant_id() AND patrol_id = $1
       ORDER BY queued_at, template_key, recipient_email`,
      [patrolId],
    );

    return { patrolId, envios: filas.map(aEnvio) };
  }

  /**
   * El registro completo de la empresa, con filtros. Es la vista de soporte:
   * incluye invitaciones y recuperaciones de clave, no solo informes de ronda.
   *
   * EL RANGO DE FECHAS SE INTERPRETA EN LA ZONA HORARIA DEL RECINTO, y por eso
   * exige `siteId`. Sin recinto no hay zona horaria: "el 3 de agosto" no empieza
   * a la misma hora en Santiago que en Isla de Pascua, y elegir en silencio la
   * del servidor haria que dos personas mirando el mismo filtro vieran periodos
   * distintos sin enterarse.
   *
   * POR ESO EL FILTRO DE RECINTO NO PUEDE EXCLUIR LO QUE NO ES DE UNA RONDA. Un
   * correo solo tiene recinto si tiene ronda, y `patrol_id` es NULL en las
   * invitaciones, las recuperaciones de clave, los escalamientos y las fallas de
   * checklist. Como filtrar por fecha OBLIGA a mandar `siteId`, un `p.site_id =
   * $1` a secas haria desaparecer en silencio la mayor parte del registro apenas
   * soporte acota por fechas —que es la forma normal de usar esta vista—. El
   * `OR md.patrol_id IS NULL` es lo que sostiene lo que promete el controlador:
   * aca se ve TODO el correo de la empresa. El recinto acota lo que tiene
   * recinto; lo que no lo tiene no queda escondido detras de un filtro que no le
   * aplica.
   */
  async listar(filtro: FiltroRegistro): Promise<EnvioRegistrado[]> {
    const desde = filtro.desde ?? null;
    const hasta = filtro.hasta ?? null;
    const siteId = filtro.siteId ?? null;

    let zonaHoraria: string | null = null;
    if (desde !== null || hasta !== null) {
      if (siteId === null) {
        throw new BadRequestException(
          'Para filtrar por fechas indica el recinto: el periodo se interpreta en su zona horaria',
        );
      }
      zonaHoraria = await this.zonaHorariaDelRecinto(siteId);
    }

    const limite = acotarLimite(filtro.limite);

    const filas = await this.tenantContext.manager.query<FilaRegistro[]>(
      `SELECT md.id, md.template_key, md.recipient_email, md.recipient_user_id, md.patrol_id,
              md.status, md.attempts, md.last_error, md.queued_at, md.sent_at,
              md.delivered_at, md.failed_at
       FROM mail_deliveries md
       LEFT JOIN patrols p ON p.tenant_id = md.tenant_id AND p.id = md.patrol_id
       WHERE md.tenant_id = app_tenant_id()
         AND ($1::uuid IS NULL OR p.site_id = $1::uuid OR md.patrol_id IS NULL)
         AND ($2::text IS NULL OR md.status = $2::text)
         AND ($3::text IS NULL OR md.template_key = $3::text)
         AND ($4::date IS NULL OR md.queued_at >= ($4::date)::timestamp AT TIME ZONE $6::text)
         AND ($5::date IS NULL OR md.queued_at < ($5::date + 1)::timestamp AT TIME ZONE $6::text)
       ORDER BY md.queued_at DESC
       LIMIT $7`,
      [siteId, filtro.estado ?? null, filtro.plantilla ?? null, desde, hasta, zonaHoraria, limite],
    );

    return filas.map(aEnvio);
  }

  // ----------------------------------------------------------------- internos

  /**
   * La zona horaria del recinto, que es la unica correcta para el rango.
   *
   * La columna es `sites.timezone` (ver 1722524400000-CreateDemoDomain): tiene
   * default en la base, asi que siempre viene con valor.
   */
  private async zonaHorariaDelRecinto(siteId: string): Promise<string> {
    const filas = await this.tenantContext.manager.query<Array<{ timezone: string }>>(
      `SELECT timezone FROM sites WHERE tenant_id = app_tenant_id() AND id = $1`,
      [siteId],
    );
    const recinto = filas[0];
    if (!recinto) throw new NotFoundException('El recinto no existe');
    return recinto.timezone;
  }

  private async verificarAlcance(
    siteId: string,
    requester: Pick<AuthenticatedUser, 'sub' | 'role'>,
  ): Promise<void> {
    if (requester.role !== 'SUPERVISOR') return;

    const asignado = await this.tenantContext.manager.query<Array<{ present: boolean }>>(
      `SELECT true AS present FROM supervisor_sites
       WHERE site_id = $1 AND supervisor_id = $2`,
      [siteId, requester.sub],
    );
    if (!asignado.length) throw new ForbiddenException('No tienes este recinto asignado');
  }

  /**
   * Transaccion propia con contexto de tenant.
   *
   * `set_config(..., true)` es SET LOCAL: acaba con la transaccion. Con `SET` a
   * secas la variable se pegaria a la conexion del pool y el siguiente request
   * heredaria el tenant anterior — la fuga que en un SaaS de empresas de
   * seguridad no se puede permitir.
   *
   * Corre dentro de `tenantContext.run()` para que cualquier servicio que se
   * apoye en TenantContextService funcione igual desde un worker que desde un
   * request.
   */
  private async enTenant<T>(
    tenantId: string,
    operacion: (manager: EntityManager) => Promise<T>,
  ): Promise<T> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    try {
      // Sin usuario y sin ventana de soporte: el registro no actua en nombre de
      // nadie y una ventana de soporte se abre para que una persona mire, no
      // para que un proceso de fondo escriba.
      await runner.manager.query(
        `SELECT
          set_config('app.tenant_id', $1, true),
          set_config('app.user_id', '', true),
          set_config('app.support_access_id', '', true)`,
        [tenantId],
      );
      const resultado = await this.tenantContext.run(runner, () => operacion(runner.manager));
      await runner.commitTransaction();
      return resultado;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  /**
   * Falla del registro, nunca del correo. Va el nombre de la clase de error y no
   * su mensaje: un error de base puede arrastrar el valor que se intento
   * escribir, y ahi viene el correo del destinatario.
   */
  private anotarFallaDeRegistro(
    evento: string,
    tenantId: string,
    jobId: string,
    error: unknown,
  ): void {
    this.logger.error(
      JSON.stringify({
        event: evento,
        tenant_id: tenantId,
        job_id: jobId,
        error: error instanceof Error ? error.name : 'Error',
      }),
    );
  }
}

interface FilaRegistro {
  id: string;
  template_key: string;
  recipient_email: string;
  recipient_user_id: string | null;
  patrol_id: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  queued_at: Date;
  sent_at: Date | null;
  delivered_at: Date | null;
  failed_at: Date | null;
}

function aEnvio(fila: FilaRegistro): EnvioRegistrado {
  return {
    id: fila.id,
    plantilla: fila.template_key,
    destinatario: fila.recipient_email,
    destinatarioUsuarioId: fila.recipient_user_id,
    patrolId: fila.patrol_id,
    estado: fila.status as EstadoEnvio,
    intentos: Number(fila.attempts),
    ultimoError: fila.last_error,
    encoladoEn: fila.queued_at,
    enviadoEn: fila.sent_at,
    entregadoEn: fila.delivered_at,
    falladoEn: fila.failed_at,
  };
}

/**
 * Filas y cantidad de un UPDATE o un DELETE.
 *
 * CON POSTGRESQL, `manager.query()` DE UN UPDATE O UN DELETE DEVUELVE
 * `[filas, cantidad]`, NO EL ARREGLO DE FILAS. TypeORM lo arma asi mirando
 * `raw.command`, aunque la consulta lleve `RETURNING` (ver
 * PostgresQueryRunner.query). Leerlo como si fuera el arreglo de filas deja
 * `filas[0]` valiendo un arreglo, la respuesta rota y el test en verde si el
 * mock devuelve `[{ ... }]`.
 *
 * Por eso esto NO tiene rama de compatibilidad: si la forma no es la tupla,
 * revienta con un mensaje claro. Un fallback silencioso volveria a permitir
 * justamente el mock que confirma lo que el autor ya creia.
 *
 * `INSERT ... RETURNING` es el otro caso y va sin esta funcion: devuelve las
 * filas planas.
 */
export function resultadoDeEscritura<T>(crudo: unknown): { filas: T[]; cantidad: number } {
  if (
    Array.isArray(crudo) &&
    crudo.length === 2 &&
    Array.isArray(crudo[0]) &&
    typeof crudo[1] === 'number'
  ) {
    return { filas: crudo[0] as T[], cantidad: crudo[1] };
  }
  throw new Error(
    'Resultado inesperado de UPDATE/DELETE: PostgreSQL devuelve [filas, cantidad]',
  );
}

/**
 * El destinatario, normalizado.
 *
 * Se acepta tanto "correo@empresa.cl" como "Jefe de turno <correo@empresa.cl>"
 * porque nodemailer acepta las dos y el producto no obliga a ninguna. En
 * minusculas para que el registro deduplique de verdad: el mismo buzon escrito
 * con mayusculas no es un segundo destinatario.
 */
export function normalizarCorreo(valor: string): string {
  const bruto = String(valor).trim();
  const conNombre = /<([^>]+)>\s*$/.exec(bruto);
  return (conNombre?.[1] ?? bruto).trim().toLowerCase();
}

const PLANTILLA_VALIDA = /^[a-z][a-z0-9:_-]{0,79}$/;

/** Deja la clave de plantilla solo si calza con el CHECK de la tabla. */
export function normalizarPlantilla(valor: string | undefined): string | null {
  if (valor === undefined) return null;
  const limpio = valor.trim().toLowerCase();
  return PLANTILLA_VALIDA.test(limpio) ? limpio : null;
}

const SEGMENTO_PLANTILLA = /^[a-z][a-z0-9-]{0,39}$/;
const UUID_SEGMENTO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Deduce la clave de plantilla desde la clave de idempotencia del correo.
 *
 * Es la RED, no el camino principal: quien encola deberia declarar su plantilla
 * (`EnqueueMailOptions.registro.plantilla`). Pero las claves de idempotencia ya
 * empiezan con el hecho de negocio —"report-dispatch:informe:<ronda>:<correo>"—
 * y aprovecharlo hace que el registro sirva desde el dia uno para los correos
 * que todavia no declaran nada, en vez de llenarse de "sin-clasificar".
 *
 * Toma como maximo los dos primeros segmentos y corta en cuanto aparece algo que
 * no es un nombre: un UUID, un correo, un token. Asi la clave nunca arrastra un
 * identificador de negocio a una columna que despues se agrupa y se muestra.
 */
export function plantillaDesdeClave(clave: string): string {
  const partes: string[] = [];

  for (const segmento of String(clave).split(':')) {
    if (partes.length >= 2) break;
    const limpio = segmento.trim().toLowerCase();
    if (!SEGMENTO_PLANTILLA.test(limpio) || UUID_SEGMENTO.test(limpio)) break;
    partes.push(limpio);
  }

  return partes.length === 0 ? PLANTILLA_DESCONOCIDA : partes.join(':');
}

/**
 * Motivo de fallo apto para guardar.
 *
 * Se queda con la primera linea (un rebote SMTP trae el diagnostico ahi y
 * despues la traza), colapsa espacios, tapa cualquier cadena larga que parezca
 * una credencial —un error de autenticacion SMTP puede venir con el usuario o el
 * token del relay— y recorta al largo que admite la columna.
 */
export function sanearMotivo(causa: unknown): string {
  const bruto =
    causa instanceof Error ? causa.message : typeof causa === 'string' ? causa : String(causa);

  const unaLinea = bruto.split('\n')[0] ?? '';
  const sinTokens = unaLinea.replace(/[A-Za-z0-9+/=_-]{24,}/g, '[oculto]');
  const compacto = sinTokens.replace(/\s+/g, ' ').trim();

  return compacto.length > MOTIVO_MAX_LARGO ? compacto.slice(0, MOTIVO_MAX_LARGO) : compacto;
}

function acotarLimite(limite: number | null | undefined): number {
  if (limite === null || limite === undefined || !Number.isInteger(limite) || limite <= 0) {
    return REGISTRO_LIMITE_DEFECTO;
  }
  return Math.min(limite, REGISTRO_LIMITE_MAXIMO);
}
