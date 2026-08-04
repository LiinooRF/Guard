import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import type { Queue } from 'bullmq';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { MailQueueService } from '../mail/mail-queue.service';
import { RulesService } from '../rules/rules.service';
import {
  ENVIO_INFORME_JOB_ATTEMPTS,
  ENVIO_INFORME_JOB_BACKOFF_MS,
  ENVIO_INFORME_JOB_NAME,
  ENVIO_INFORME_QUEUE_NAME,
} from './envio-informe.constants';
import {
  INFORME_AL_CIERRE,
  INFORME_BAJO_UMBRAL,
  variablesInforme,
} from './envio-informe.plantillas';
import {
  omitir,
  type DestinatarioEnvio,
  type EnvioInformeJobData,
  type ResultadoEnvio,
} from './envio-informe.types';
import type { InformeRonda } from './patrol-report.model';
import { PatrolReportService } from './patrol-report.service';

/**
 * Envio automatico del informe al cierre de la ronda y alerta bajo umbral (#86).
 *
 * EL FLUJO, DE PUNTA A PUNTA
 *   1. El guardia marca el punto de cierre. GuardService cierra la ronda y llama
 *      a `alCerrarRonda()`, que solo ENCOLA. El escaneo responde enseguida: el
 *      guardia esta en terreno y su registro no puede esperar a que se dibuje un
 *      PDF.
 *   2. El worker (envio-informe.processor.ts) abre transaccion con contexto de
 *      tenant y llama a `despachar()`.
 *   3. `despachar()` resuelve reglas y destinatarios, genera el informe, deja
 *      una fila por destinatario y encola los correos.
 *
 * TRES CAPAS DE IDEMPOTENCIA, Y CADA UNA CUBRE UN AGUJERO DISTINTO
 *   - El job de despacho lleva jobId derivado del patrolId: reprocesar la misma
 *     ronda no crea un segundo despacho.
 *   - Cada correo se encola con clave de idempotencia propia: aunque el job se
 *     reintente despues de fallar a mitad de camino, BullMQ no entrega dos veces
 *     el mismo correo al mismo destinatario.
 *   - La tabla `report_deliveries` guarda quien ya lo recibio. Es la unica capa
 *     que sobrevive a que se limpie Redis, y ademas responde la pregunta del
 *     jefe de operaciones: "¿a quien le llego el informe de esa ronda?".
 *
 * QUIEN RECIBE QUE
 *   - Informe (asunto normal): los administradores del tenant MAS los correos de
 *     `reportRecipients`, que se configura por tenant y se pisa por recinto.
 *   - Alerta bajo umbral (OTRO asunto, mismo PDF): solo los administradores, y
 *     ademas del informe, no en vez de el.
 */

/** Estados en los que una ronda ya termino y el informe tiene sentido. */
const RONDAS_CERRADAS = new Set(['completada', 'incompleta', 'vencida']);

interface RondaRow {
  site_id: string;
  status: string;
  compliance_pct: string | null;
}

interface AdminRow {
  id: string;
  email: string;
}

interface EntregaRow {
  kind: string;
  recipient_email: string;
  recipient_user_id: string | null;
  compliance_pct: string | null;
  attached: boolean;
  queued_at: Date;
}

@Injectable()
export class EnvioInformeService {
  private readonly logger = new Logger(EnvioInformeService.name);

  constructor(
    @InjectQueue(ENVIO_INFORME_QUEUE_NAME)
    private readonly queue: Queue<EnvioInformeJobData>,
    private readonly tenantContext: TenantContextService,
    private readonly informe: PatrolReportService,
    private readonly mail: MailQueueService,
    private readonly rules: RulesService,
  ) {}

  // ------------------------------------------------------------------ disparo

  /**
   * Lo llama GuardService justo despues de cerrar la ronda, dentro de la misma
   * transaccion del escaneo.
   *
   * Solo encola. Si el envio automatico esta apagado o no hay destinatarios, eso
   * lo decide el worker con las reglas vigentes al despachar: resolverlo aca
   * sumaria consultas al camino critico del guardia para ahorrar un job que
   * cuesta microsegundos.
   *
   * Devuelve null cuando la ronda no existe o todavia no esta cerrada, para no
   * quemar el jobId —que es unico por ronda y no se puede reciclar— en un
   * despacho que no corresponde.
   */
  async alCerrarRonda(patrolId: string): Promise<{ jobId: string } | null> {
    const filas = await this.tenantContext.manager.query<
      Array<{ tenant_id: string; status: string }>
    >(`SELECT tenant_id, status FROM patrols WHERE id = $1`, [patrolId]);

    const ronda = filas[0];
    if (!ronda) return null;
    if (!RONDAS_CERRADAS.has(ronda.status)) return null;

    // Misma politica que la cola de correo: la clave se hashea para no dejar
    // identificadores de negocio legibles en Redis, y los completados se
    // retienen para que la deduplicacion siga valiendo manana.
    const jobId = createHash('sha256').update(`envio-informe:${patrolId}`).digest('hex');
    const job = await this.queue.add(
      ENVIO_INFORME_JOB_NAME,
      { tenantId: ronda.tenant_id, patrolId },
      {
        jobId,
        attempts: ENVIO_INFORME_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: ENVIO_INFORME_JOB_BACKOFF_MS },
        removeOnComplete: false,
        removeOnFail: false,
      },
    );

    return { jobId: job.id ?? jobId };
  }

  // ----------------------------------------------------------------- despacho

  /**
   * Genera el informe y lo manda a quien corresponda. Corre DENTRO de una
   * transaccion con `app.tenant_id` seteado (la abre el processor): todas las
   * consultas de aca abajo pasan por RLS igual que las de un request.
   */
  async despachar(tenantId: string, patrolId: string): Promise<ResultadoEnvio> {
    const filas = await this.tenantContext.manager.query<RondaRow[]>(
      `SELECT site_id, status, compliance_pct FROM patrols WHERE id = $1`,
      [patrolId],
    );
    const ronda = filas[0];
    if (!ronda) return omitir(patrolId, 'ronda_inexistente');
    if (!RONDAS_CERRADAS.has(ronda.status)) return omitir(patrolId, 'ronda_sin_cerrar');

    // Reglas resueltas CON el recinto: los destinatarios y el umbral se
    // configuran por tenant y se pisan por recinto (cascada de #80). Pedirlas
    // sin recinto devolveria la lista del tenant e ignoraria la del recinto,
    // que es justo lo que el issue pide soportar.
    const reglas = await this.rules.effective({ siteId: ronda.site_id });

    const admins = await this.administradores();
    const destinatarios = this.armarDestinatarios(admins, reglas.reportRecipients);
    if (destinatarios.length === 0) {
      // Sin correo no hay informe que mandar. Se registra porque casi siempre
      // significa que el tenant se creo sin admin con correo, no que asi lo
      // quisieron.
      this.logger.warn(
        JSON.stringify({
          event: 'informe_sin_destinatarios',
          tenant_id: tenantId,
          patrol_id: patrolId,
        }),
      );
      return omitir(patrolId, 'sin_destinatarios');
    }

    // Chequeo barato ANTES de dibujar: si todo lo que corresponde mandar ya
    // quedo registrado, el reproceso no genera el PDF siquiera. Se usa el
    // cumplimiento que quedo persistido al cerrar; el definitivo se recalcula
    // despues, con el informe ya armado.
    const pctPersistido = ronda.compliance_pct === null ? null : Number(ronda.compliance_pct);
    const planTentativo = this.planificar(
      destinatarios,
      pctPersistido !== null && pctPersistido < reglas.complianceThreshold,
      reglas.autoSendReportOnClose,
    );
    if (planTentativo.length === 0) return omitir(patrolId, 'envio_desactivado');

    const yaRegistrados = await this.registradas(patrolId);
    if (planTentativo.every((destino) => yaRegistrados.has(clave(destino)))) {
      return omitir(patrolId, 'ya_enviado');
    }

    const modelo = await this.informe.buildModel(patrolId, {
      // Contexto de sistema: no hay usuario pidiendo el informe. El alcance por
      // recinto no aplica porque nadie esta consultando nada.
      requester: null,
      // Sin anexo fotografico: el adjunto viaja en base64 dentro de un job de
      // Redis. El anexo completo lo baja quien quiera desde el panel.
      incluirAnexo: false,
    });
    const pdf = await this.dibujar(modelo);

    // El veredicto se toma con el umbral DEL RECINTO y con el cumplimiento
    // recien calculado, no con el que quedo persistido: entre el cierre y el
    // despacho pudo entrar un escaneo atrasado desde la sincronizacion offline.
    const bajoUmbral = modelo.compliance.pct < reglas.complianceThreshold;
    const plan = this.planificar(destinatarios, bajoUmbral, reglas.autoSendReportOnClose);

    const maxBytes = reglas.reportMailMaxAttachmentMB * 1024 * 1024;
    const adjuntar = pdf.length <= maxBytes;
    const adjuntos = adjuntar
      ? [
          {
            filename: modelo.filename,
            contentType: 'application/pdf',
            contentBase64: pdf.toString('base64'),
          },
        ]
      : undefined;

    const variables = variablesInforme({
      ruta: modelo.recinto.ruta,
      recinto: modelo.recinto.nombre,
      sucursal: modelo.recinto.sucursal,
      guardia: modelo.recinto.guardia,
      timezone: modelo.timezone,
      inicio: modelo.ejecucion.inicio,
      cierre: modelo.ejecucion.cierre,
      compliance: modelo.compliance,
      umbral: reglas.complianceThreshold,
      novedades: modelo.incidentes.length,
      adjunto: {
        incluido: adjuntar,
        filename: modelo.filename,
        bytes: pdf.length,
        maxMB: reglas.reportMailMaxAttachmentMB,
      },
      pie: modelo.marca.mailFooter,
    });

    let informes = 0;
    let alertas = 0;
    for (const destino of plan) {
      // Primero la fila y despues el correo, igual que la cadena de
      // escalamiento: si el correo falla, el job se reintenta completo, la
      // transaccion ya volvio atras y la clave de idempotencia del correo evita
      // el duplicado. Al reves quedaria un informe enviado que la bitacora no
      // registra, y el proximo reproceso lo mandaria de nuevo.
      const registrada = await this.registrar(destino, patrolId, modelo.compliance.pct, adjuntar);
      if (!registrada) continue;

      await this.mail.enqueue(
        {
          to: destino.email,
          template: destino.kind === 'alerta' ? INFORME_BAJO_UMBRAL : INFORME_AL_CIERRE,
          variables,
          tenantId,
          ...(adjuntos === undefined ? {} : { attachments: adjuntos }),
        },
        { idempotencyKey: `report-dispatch:${destino.kind}:${patrolId}:${destino.email}` },
      );

      if (destino.kind === 'alerta') alertas += 1;
      else informes += 1;
    }

    // Solo identificadores y conteos: ni correos, ni nombres, ni el recinto.
    this.logger.log(
      JSON.stringify({
        event: 'informe_despachado',
        tenant_id: tenantId,
        patrol_id: patrolId,
        informes,
        alertas,
        adjunto: adjuntar,
      }),
    );

    return { patrolId, informes, alertas, adjunto: adjuntar, omitido: null };
  }

  // ------------------------------------------------------------------ consulta

  /**
   * Que se envio de esa ronda y a quien. Lo consulta el panel para responder
   * "¿le llegó el informe al cliente?" sin abrir la bandeja de nadie.
   *
   * El SUPERVISOR esta limitado a SUS recintos asignados: el permiso
   * reports:read no alcanza por si solo (ver CLAUDE.md y roles.ts).
   */
  async estadoDeEnvio(patrolId: string, requester: Pick<AuthenticatedUser, 'sub' | 'role'>) {
    const filas = await this.tenantContext.manager.query<RondaRow[]>(
      `SELECT site_id, status, compliance_pct FROM patrols WHERE id = $1`,
      [patrolId],
    );
    const ronda = filas[0];
    if (!ronda) throw new NotFoundException('La ronda no existe');
    await this.verificarAlcance(ronda.site_id, requester);

    const reglas = await this.rules.effective({ siteId: ronda.site_id });
    const entregas = await this.tenantContext.manager.query<EntregaRow[]>(
      `SELECT kind, recipient_email, recipient_user_id, compliance_pct, attached, queued_at
       FROM report_deliveries
       WHERE tenant_id = app_tenant_id() AND patrol_id = $1
       ORDER BY queued_at, kind, recipient_email`,
      [patrolId],
    );

    return {
      patrolId,
      status: ronda.status,
      autoSendEnabled: reglas.autoSendReportOnClose,
      complianceThreshold: reglas.complianceThreshold,
      compliancePct: ronda.compliance_pct === null ? null : Number(ronda.compliance_pct),
      deliveries: entregas.map((entrega) => ({
        kind: entrega.kind,
        recipientEmail: entrega.recipient_email,
        recipientUserId: entrega.recipient_user_id,
        compliancePct: entrega.compliance_pct === null ? null : Number(entrega.compliance_pct),
        attached: entrega.attached,
        queuedAt: entrega.queued_at,
      })),
    };
  }

  // --------------------------------------------------------------- internos

  /**
   * Administradores del tenant con correo. Un guardia sin correo es normal en
   * este producto (ver CLAUDE.md); un admin sin correo simplemente no recibe.
   */
  private async administradores(): Promise<AdminRow[]> {
    return this.tenantContext.manager.query<AdminRow[]>(
      `SELECT u.id, u.email
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = app_tenant_id()
         AND m.role_key = 'ADMIN'
         AND u.is_active
         AND u.email IS NOT NULL`,
    );
  }

  /**
   * Destinatarios del informe: los administradores de la empresa MAS la lista
   * configurable (`reportRecipients`), que se resuelve por tenant y se pisa por
   * recinto. Es la definicion que ya declara el catalogo de reglas.
   *
   * Se normaliza a minusculas para que la bitacora deduplique de verdad: el
   * mismo buzon escrito con mayusculas no es un segundo destinatario.
   */
  private armarDestinatarios(
    admins: readonly AdminRow[],
    extras: readonly string[],
  ): DestinatarioEnvio[] {
    const vistos = new Set<string>();
    const destinatarios: DestinatarioEnvio[] = [];

    for (const admin of admins) {
      const email = normalizar(admin.email);
      if (email.length === 0 || vistos.has(email)) continue;
      vistos.add(email);
      destinatarios.push({ kind: 'informe', email, userId: admin.id });
    }

    for (const extra of extras) {
      const email = normalizar(extra);
      if (email.length === 0 || vistos.has(email)) continue;
      vistos.add(email);
      destinatarios.push({ kind: 'informe', email, userId: null });
    }

    return destinatarios;
  }

  /**
   * El plan de correos de este despacho.
   *
   * Bajo umbral, el administrador recibe DOS: el informe como todos los dias y
   * la alerta con otro asunto. No es redundancia: el informe se archiva y la
   * alerta se atiende, y quien tiene la bandeja llena necesita distinguirlos.
   *
   * LA ALERTA NO DEPENDE DE `autoSendReportOnClose`. Apagar el envio automatico
   * significa "no me mandes el informe de todos los dias", no "no me avises
   * cuando una ronda se hizo a medias": esa alerta es la regla que dio origen al
   * producto y ya salia antes de este issue (#64). Apagarla tiene que ser una
   * decision explicita, no el efecto lateral de otra.
   */
  private planificar(
    destinatarios: readonly DestinatarioEnvio[],
    bajoUmbral: boolean,
    enviarInforme: boolean,
  ): DestinatarioEnvio[] {
    const informes = enviarInforme ? [...destinatarios] : [];
    if (!bajoUmbral) return informes;
    const alertas = destinatarios
      // Solo a los administradores: el correo externo del cliente final recibe
      // el informe, no el aviso interno de que su servicio anduvo mal.
      .filter((destino) => destino.userId !== null)
      .map((destino) => ({ ...destino, kind: 'alerta' as const }));
    return [...informes, ...alertas];
  }

  /** Lo ya despachado de esta ronda, como claves "tipo|correo". */
  private async registradas(patrolId: string): Promise<Set<string>> {
    const filas = await this.tenantContext.manager.query<
      Array<{ kind: string; recipient_email: string }>
    >(
      `SELECT kind, recipient_email
       FROM report_deliveries
       WHERE tenant_id = app_tenant_id() AND patrol_id = $1`,
      [patrolId],
    );
    return new Set(filas.map((fila) => `${fila.kind}|${fila.recipient_email}`));
  }

  /**
   * Registra el despacho. Devuelve false cuando la fila ya existia, que es la
   * señal de "a este ya se le envio": el correo no se encola de nuevo.
   *
   * `INSERT ... RETURNING` en PostgreSQL devuelve las filas planas (a diferencia
   * de UPDATE y DELETE, que devuelven [filas, cantidad]); por eso `length`
   * alcanza para saber si entro.
   */
  private async registrar(
    destino: DestinatarioEnvio,
    patrolId: string,
    compliancePct: number,
    adjuntado: boolean,
  ): Promise<boolean> {
    const filas = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `INSERT INTO report_deliveries (
        tenant_id, patrol_id, kind, recipient_email, recipient_user_id,
        compliance_pct, attached
      ) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6)
      ON CONFLICT (tenant_id, patrol_id, kind, recipient_email) DO NOTHING
      RETURNING id`,
      [patrolId, destino.kind, destino.email, destino.userId, compliancePct, adjuntado],
    );
    return filas.length > 0;
  }

  /**
   * Los bytes del informe.
   *
   * No se usa `PatrolReportService.toBuffer()` porque este servicio necesita
   * ademas el MODELO para escribir el correo (recinto, ruta, guardia, horas,
   * novedades), y toBuffer() vuelve a resolverlo por dentro: serian todas las
   * consultas del informe corriendo dos veces por cada ronda que cierra.
   */
  private async dibujar(modelo: InformeRonda): Promise<Buffer> {
    const canal = new PassThrough();
    const partes: Buffer[] = [];
    canal.on('data', (parte: Buffer) => partes.push(parte));
    // render() resuelve recien cuando el stream de destino termino, asi que
    // para cuando esto retorna ya estan todos los pedazos.
    await this.informe.render(modelo, canal);
    return Buffer.concat(partes);
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
}

function normalizar(email: string): string {
  return String(email).trim().toLowerCase();
}

function clave(destino: DestinatarioEnvio): string {
  return `${destino.kind}|${destino.email}`;
}
