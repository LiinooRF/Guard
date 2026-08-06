import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { PatrolRules } from '@voxia/shared';
import { createHash } from 'node:crypto';

import { filasDe } from '../consent/sql-result';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { Criticality } from '../guard/dto/report-event.dto';
import { MailQueueService } from '../mail/mail-queue.service';
import { RulesService } from '../rules/rules.service';
import {
  ESCALATION_CRITICALITIES,
  type EscalationCriticality,
  type NotifyRole,
  type UpdateEscalationPoliciesDto,
} from './dto/update-escalation-policies.dto';

const ALERTA_ESCALAMIENTO = {
  subject: '[Nivel {{level}}] {{criticality}} en {{site}}',
  text:
    '{{guard}} reportó un evento de criticidad {{criticality}} en {{site}}.\n\n' +
    '"{{text}}"\n\n' +
    'Hora (servidor): {{at}}\n' +
    'Ubicación: {{location}}\n\n' +
    'Acusa recibo en el panel de VoxIA Control. Mientras nadie lo haga, la ' +
    'alerta sube al siguiente nivel de la cadena.',
} as const;

const ALERTA_FALSA_ALARMA = {
  subject: 'Falsa alarma: {{site}}',
  text:
    '{{guard}} marcó como FALSA ALARMA el evento reportado en {{site}}.\n\n' +
    'Motivo: "{{reason}}"\n' +
    'Hora (servidor): {{at}}\n\n' +
    'La entrada original no se borró: sigue en el libro, con esta corrección ' +
    'asociada.',
} as const;

export interface EscalationLevel {
  level: number;
  notifyRole: NotifyRole | null;
  notifyEmail: string | null;
  delayMinutes: number;
  /** true = no hay filas del tenant, es la cadena por defecto del producto. */
  isDefault: boolean;
}

export interface EventContext {
  siteId: string;
  guardId: string;
  text?: string;
  latitude?: number;
  longitude?: number;
}

interface PolicyRow {
  criticality: EscalationCriticality;
  level: number;
  notify_role: NotifyRole | null;
  notify_email: string | null;
  delay_minutes: number;
}

interface Recipient {
  userId: string | null;
  email: string;
}

@Injectable()
export class EscalationService {
  private readonly logger = new Logger(EscalationService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly mail: MailQueueService,
    private readonly rules: RulesService,
  ) {}

  // --------------------------------------------------------------- cadena

  /**
   * Cadena del tenant para esa criticidad, ordenada por nivel. Sin filas
   * configuradas devuelve la cadena por defecto: supervisor inmediato y admin
   * despues del retraso de las reglas. Un tenant recien creado escala igual.
   */
  async policiesFor(
    criticality: EscalationCriticality,
    rules?: PatrolRules,
  ): Promise<EscalationLevel[]> {
    const filas = await this.tenantContext.manager.query<PolicyRow[]>(
      `SELECT criticality, level, notify_role, notify_email, delay_minutes
       FROM escalation_policies
       WHERE tenant_id = app_tenant_id() AND criticality = $1
       ORDER BY level`,
      [criticality],
    );
    if (!filas.length) return this.defaultChain(rules ?? (await this.rules.effective()));
    return filas.map((f) => ({
      level: Number(f.level),
      notifyRole: f.notify_role,
      notifyEmail: f.notify_email,
      delayMinutes: Number(f.delay_minutes),
      isDefault: false,
    }));
  }

  private defaultChain(rules: PatrolRules): EscalationLevel[] {
    return [
      {
        level: 1,
        notifyRole: 'SUPERVISOR',
        notifyEmail: null,
        delayMinutes: 0,
        isDefault: true,
      },
      {
        level: 2,
        notifyRole: 'ADMIN',
        notifyEmail: null,
        delayMinutes: rules.escalationDefaultDelayMin,
        isDefault: true,
      },
    ];
  }

  /** Vista del admin: la cadena vigente de cada criticidad, con su origen. */
  async listPolicies() {
    const rules = await this.rules.effective();
    const filas = await this.tenantContext.manager.query<PolicyRow[]>(
      `SELECT criticality, level, notify_role, notify_email, delay_minutes
       FROM escalation_policies
       WHERE tenant_id = app_tenant_id()
       ORDER BY criticality, level`,
    );

    const chains = ESCALATION_CRITICALITIES.map((criticality) => {
      const propias = filas.filter((f) => f.criticality === criticality);
      const levels: EscalationLevel[] = propias.length
        ? propias.map((f) => ({
            level: Number(f.level),
            notifyRole: f.notify_role,
            notifyEmail: f.notify_email,
            delayMinutes: Number(f.delay_minutes),
            isDefault: false,
          }))
        : this.defaultChain(rules);
      return { criticality, isDefault: !propias.length, levels };
    });

    return { escalatingCriticalities: rules.escalationCriticalities, chains };
  }

  /**
   * Reemplaza el set COMPLETO de cadenas del tenant: una criticidad omitida
   * vuelve a la cadena por defecto. Mismo criterio que los overrides de reglas.
   */
  async replacePolicies(input: UpdateEscalationPoliciesDto) {
    const vistas = new Set<string>();
    for (const chain of input.chains) {
      if (vistas.has(chain.criticality)) {
        throw new BadRequestException(`La criticidad ${chain.criticality} viene repetida`);
      }
      vistas.add(chain.criticality);

      const niveles = chain.levels.map((l) => l.level);
      if (new Set(niveles).size !== niveles.length) {
        throw new BadRequestException(`Hay niveles repetidos en ${chain.criticality}`);
      }
      // Sin nivel 1 no se avisa a nadie cuando entra el evento: la cadena
      // completa quedaria esperando un vencimiento que nunca llega.
      if (!niveles.includes(1)) {
        throw new BadRequestException(`La cadena de ${chain.criticality} debe partir en el nivel 1`);
      }
      for (const nivel of chain.levels) {
        if ((nivel.notifyRole === undefined) === (nivel.notifyEmail === undefined)) {
          throw new BadRequestException(
            `El nivel ${nivel.level} de ${chain.criticality} necesita un rol o un correo, no ambos`,
          );
        }
      }
    }

    await this.tenantContext.manager.query(
      `DELETE FROM escalation_policies WHERE tenant_id = app_tenant_id()`,
    );
    for (const chain of input.chains) {
      for (const nivel of chain.levels) {
        await this.tenantContext.manager.query(
          `INSERT INTO escalation_policies (
            tenant_id, criticality, level, notify_role, notify_email, delay_minutes
          ) VALUES (app_tenant_id(), $1, $2, $3, $4, $5)`,
          [
            chain.criticality,
            nivel.level,
            nivel.notifyRole ?? null,
            nivel.notifyEmail ?? null,
            nivel.delayMinutes ?? 0,
          ],
        );
      }
    }
    return this.listPolicies();
  }

  // ----------------------------------------------------------- notificacion

  /**
   * Entra el nivel 1 de la cadena: encola el correo y deja una fila de acuse
   * por destinatario. Devuelve cuantos quedaron notificados.
   *
   * Que criticidades escalan lo decide la regla del tenant, no el codigo: una
   * empresa quiere que 'media' despierte al supervisor y otra no.
   */
  async notify(
    eventId: string,
    criticality: Criticality,
    contexto: EventContext,
  ): Promise<number> {
    const rules = await this.rules.effective();
    if (!esEscalable(criticality)) return 0;
    if (!(rules.escalationCriticalities as readonly string[]).includes(criticality)) return 0;

    const cadena = await this.policiesFor(criticality, rules);
    const nivel = cadena[0];
    if (!nivel) return 0;

    const info = await this.eventContext(contexto.siteId, contexto.guardId);
    if (!info) return 0;

    const destinatarios = await this.recipientsFor(nivel, contexto.siteId);
    if (!destinatarios.length) {
      this.logger.warn(
        JSON.stringify({ event: 'escalamiento_sin_destinatarios', level: nivel.level }),
      );
      return 0;
    }

    const vars = {
      site: info.site_name,
      guard: info.guard_name,
      criticality,
      level: nivel.level,
      text: contexto.text ?? '(sin texto)',
      at: new Date().toISOString(),
      location:
        contexto.latitude !== undefined && contexto.longitude !== undefined
          ? `${contexto.latitude}, ${contexto.longitude}`
          : 'sin GPS',
    };

    let enviados = 0;
    for (const destino of destinatarios) {
      // Primero la fila, despues el correo: si el correo falla, BullMQ
      // reintenta con la misma clave y el acuse ya existe. Al reves quedaria
      // una alerta enviada que nadie puede acusar.
      const registrada = await this.tenantContext.manager.query<Array<{ id: string }>>(
        `INSERT INTO event_notifications (
          tenant_id, field_event_id, level, recipient_user_id, recipient_email
        ) VALUES (app_tenant_id(), $1, $2, $3, $4)
        ON CONFLICT (tenant_id, field_event_id, level, recipient_email) DO NOTHING
        RETURNING id`,
        [eventId, nivel.level, destino.userId, destino.email],
      );
      if (!registrada.length) continue;

      const encolado = await this.mail.enqueue(
        {
          to: destino.email,
          template: ALERTA_ESCALAMIENTO,
          variables: vars,
          tenantId: info.tenant_id,
        },
        { idempotencyKey: `escalation:${eventId}:${nivel.level}:${destino.email}` },
      );
      // Suprimido por dominio (#86) no es enviado. La fila de
      // `event_notifications` queda igual —es el acuse, y borrarla romperia la
      // idempotencia del reintento—, pero este contador es lo que mira quien
      // pregunta si la alerta salio. Un panico que no se notifico no se cuenta.
      if (encolado.estado === 'encolado') enviados += 1;
    }
    return enviados;
  }

  /**
   * Destinatarios de un nivel. El SUPERVISOR se filtra por recinto asignado:
   * escalarle un evento de un recinto que no supervisa es filtrarle datos que
   * no le corresponden, ademas de ruido que le hace ignorar la proxima alerta.
   */
  private async recipientsFor(nivel: EscalationLevel, siteId: string): Promise<Recipient[]> {
    if (nivel.notifyEmail) return [{ userId: null, email: nivel.notifyEmail }];
    if (!nivel.notifyRole) return [];

    const filas = await this.tenantContext.manager.query<Array<{ id: string; email: string }>>(
      `SELECT u.id, u.email
       FROM memberships m
       JOIN users u ON u.id = m.user_id
       WHERE m.role_key = $1
         AND u.is_active
         AND u.email IS NOT NULL
         AND (
           m.role_key <> 'SUPERVISOR'
           OR EXISTS (
             SELECT 1 FROM supervisor_sites ss
             WHERE ss.supervisor_id = m.user_id AND ss.site_id = $2
           )
         )`,
      [nivel.notifyRole, siteId],
    );
    return filas.map((f) => ({ userId: f.id, email: f.email }));
  }

  private async eventContext(siteId: string, guardId: string) {
    const filas = await this.tenantContext.manager.query<
      Array<{ tenant_id: string; site_name: string; guard_name: string }>
    >(
      `SELECT s.tenant_id, s.name AS site_name,
              (u.given_name || ' ' || u.family_name) AS guard_name
       FROM sites s, users u
       WHERE s.id = $1 AND u.id = $2`,
      [siteId, guardId],
    );
    return filas[0];
  }

  // ------------------------------------------------------------------ acuse

  /** Alguien se hizo cargo. Un segundo acuse es 409: el primero manda. */
  async acknowledge(notificationId: string, userId: string) {
    /*
     * `filasDe` porque un UPDATE pelado devuelve [filas, rowCount]: `filas[0]`
     * era el ARREGLO de filas —truthy aunque venga vacio—, asi que el segundo
     * acuse respondia 200 con id y eventId undefined y level NaN en vez del 409.
     * Justo lo contrario de lo que documenta esta funcion.
     */
    const filas = filasDe<{
      id: string;
      field_event_id: string;
      level: number;
      acknowledged_at: Date;
    }>(
      await this.tenantContext.manager.query(
        `UPDATE event_notifications
         SET acknowledged_at = now(), acknowledged_by = $2
         WHERE id = $1 AND tenant_id = app_tenant_id() AND acknowledged_at IS NULL
         RETURNING id, field_event_id, level, acknowledged_at`,
        [notificationId, userId],
      ),
    );
    const acuse = filas[0];
    if (acuse) {
      return {
        id: acuse.id,
        eventId: acuse.field_event_id,
        level: Number(acuse.level),
        acknowledgedAt: acuse.acknowledged_at,
        acknowledgedBy: userId,
      };
    }

    const existente = await this.tenantContext.manager.query<Array<{ acknowledged_at: Date }>>(
      `SELECT acknowledged_at FROM event_notifications
       WHERE id = $1 AND tenant_id = app_tenant_id()`,
      [notificationId],
    );
    if (!existente.length) throw new NotFoundException('La notificación no existe');
    throw new ConflictException('Esa alerta ya tiene acuse de recibo');
  }

  /**
   * Notificaciones con su plazo vencido y sin acuse: las que corresponde subir
   * al nivel siguiente. Es la CONSULTA del job, no el job.
   *
   * EL CRON NO ESTA IMPLEMENTADO A PROPOSITO: un scheduler dentro de la API se
   * dispara en cada replica y manda la alerta N veces. Cuando exista, va como
   * worker BullMQ repetible (ver INTEGRACION.md), y este metodo es lo que
   * consumira.
   */
  async pendingEscalations() {
    const rules = await this.rules.effective();
    const porDefecto = this.defaultChain(rules);
    const nivel2 = porDefecto.find((n) => n.level === 2);

    const filas = await this.tenantContext.manager.query<
      Array<{
        notification_id: string;
        field_event_id: string;
        level: number;
        sent_at: Date;
        criticality: EscalationCriticality;
        site_id: string;
        next_level: number | null;
        next_notify_role: NotifyRole | null;
        next_notify_email: string | null;
      }>
    >(
      `SELECT n.id AS notification_id, n.field_event_id, n.level, n.sent_at,
              e.criticality, e.site_id,
              siguiente.level AS next_level,
              siguiente.notify_role AS next_notify_role,
              siguiente.notify_email AS next_notify_email
       FROM event_notifications n
       JOIN field_events e
         ON e.tenant_id = n.tenant_id AND e.id = n.field_event_id
       LEFT JOIN escalation_policies siguiente
         ON siguiente.tenant_id = n.tenant_id
        AND siguiente.criticality = e.criticality
        AND siguiente.level = n.level + 1
       WHERE n.tenant_id = app_tenant_id()
         AND n.acknowledged_at IS NULL
         AND n.level < 3
         AND now() >= n.sent_at
              + (COALESCE(siguiente.delay_minutes, $1::integer) * interval '1 minute')
         AND (
           siguiente.level IS NOT NULL
           OR (
             n.level = 1
             AND NOT EXISTS (
               SELECT 1 FROM escalation_policies configurada
               WHERE configurada.tenant_id = n.tenant_id
                 AND configurada.criticality = e.criticality
             )
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM event_notifications posterior
           WHERE posterior.tenant_id = n.tenant_id
             AND posterior.field_event_id = n.field_event_id
             AND posterior.level > n.level
         )
         AND NOT EXISTS (
           SELECT 1 FROM field_events correccion
           WHERE correccion.tenant_id = n.tenant_id
             AND correccion.corrects_event_id = n.field_event_id
             AND correccion.criticality = 'info'
         )
       ORDER BY n.sent_at`,
      [rules.escalationDefaultDelayMin],
    );

    return filas.map((f) => ({
      notificationId: f.notification_id,
      eventId: f.field_event_id,
      criticality: f.criticality,
      siteId: f.site_id,
      level: Number(f.level),
      sentAt: f.sent_at,
      nextLevel: f.next_level === null ? Number(f.level) + 1 : Number(f.next_level),
      nextNotifyRole:
        f.next_notify_role ?? (f.next_notify_email ? null : (nivel2?.notifyRole ?? null)),
      nextNotifyEmail: f.next_notify_email,
    }));
  }

  // ----------------------------------------------------------- falsa alarma

  /**
   * Falsa alarma (#127). NO muta el evento original: registra una entrada nueva
   * de criticidad 'info' con corrects_event_id apuntando al panico. field_events
   * es append-only en PostgreSQL y ese registro termina en juicios laborales:
   * lo que se reportó tiene que seguir visible junto a su corrección.
   *
   * El client_event_id se deriva del evento original, asi que reenviar la
   * cancelacion tras un timeout devuelve la misma correccion en vez de sumar
   * entradas repetidas al libro.
   */
  async cancelAsFalseAlarm(eventId: string, guardId: string, reason: string) {
    const filas = await this.tenantContext.manager.query<
      Array<{
        id: string;
        site_id: string;
        patrol_id: string | null;
        guard_id: string;
        criticality: Criticality;
      }>
    >(
      `SELECT id, site_id, patrol_id, guard_id, criticality
       FROM field_events WHERE id = $1`,
      [eventId],
    );
    const original = filas[0];
    if (!original) throw new NotFoundException('El evento no existe');
    if (original.guard_id !== guardId) {
      throw new ForbiddenException('Solo quien reportó el evento puede marcarlo como falsa alarma');
    }
    if (original.criticality === 'info') {
      throw new ConflictException('Una entrada informativa no es una alarma que cancelar');
    }

    const motivo = reason.trim();
    const clientEventId = uuidDerivado(`false-alarm:${eventId}`);
    const insertadas = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `INSERT INTO field_events (
        tenant_id, site_id, patrol_id, guard_id, criticality, text,
        corrects_event_id, client_event_id
      ) VALUES (app_tenant_id(), $1, $2, $3, 'info', $4, $5, $6)
      ON CONFLICT (tenant_id, guard_id, client_event_id) DO NOTHING
      RETURNING id`,
      [original.site_id, original.patrol_id, guardId, motivo, eventId, clientEventId],
    );

    const correccion = insertadas[0];
    if (!correccion) {
      const existente = await this.tenantContext.manager.query<Array<{ id: string }>>(
        `SELECT id FROM field_events WHERE guard_id = $1 AND client_event_id = $2`,
        [guardId, clientEventId],
      );
      return {
        eventId,
        correctionId: existente[0]?.id ?? null,
        replay: true,
        notified: 0,
      };
    }

    const avisados = await this.avisarCancelacion(
      eventId,
      correccion.id,
      motivo,
      original.site_id,
      guardId,
    );
    return { eventId, correctionId: correccion.id, replay: false, notified: avisados };
  }

  /**
   * Avisa a quienes ya salieron a atender el panico. Un fallo aca no puede
   * botar la correccion: la entrada del libro vale mas que el correo.
   */
  private async avisarCancelacion(
    eventId: string,
    correctionId: string,
    reason: string,
    siteId: string,
    guardId: string,
  ) {
    try {
      const destinos = await this.tenantContext.manager.query<
        Array<{ id: string; recipient_email: string }>
      >(
        `SELECT id, recipient_email FROM event_notifications
         WHERE tenant_id = app_tenant_id() AND field_event_id = $1`,
        [eventId],
      );
      if (!destinos.length) return 0;

      const info = await this.eventContext(siteId, guardId);
      if (!info) return 0;

      const vars = {
        site: info.site_name,
        guard: info.guard_name,
        reason,
        at: new Date().toISOString(),
      };
      let avisados = 0;
      for (const destino of destinos) {
        const encolado = await this.mail.enqueue(
          {
            to: destino.recipient_email,
            template: ALERTA_FALSA_ALARMA,
            variables: vars,
            tenantId: info.tenant_id,
          },
          { idempotencyKey: `false-alarm:${correctionId}:${destino.id}` },
        );
        // Antes devolvia `destinos.length` sin mirar nada: el numero era "a
        // cuantos correspondia avisar", no "a cuantos se aviso". Con la
        // supresion por dominio (#86) esa diferencia deja de ser teorica.
        if (encolado.estado === 'encolado') avisados += 1;
      }
      return avisados;
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'aviso_falsa_alarma_fallo',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return 0;
    }
  }
}

function esEscalable(criticality: Criticality): criticality is EscalationCriticality {
  return (ESCALATION_CRITICALITIES as readonly string[]).includes(criticality);
}

/**
 * UUID v5-like derivado de una semilla. El client_event_id de field_events es
 * uuid y unico por (tenant, guardia): derivarlo hace idempotente el reenvio sin
 * agregar columnas ni tablas.
 */
function uuidDerivado(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex');
  const variante = ((parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variante}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}
