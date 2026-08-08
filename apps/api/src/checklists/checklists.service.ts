import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { EventsStreamService } from '../events-stream/events-stream.service';
import { MailQueueService } from '../mail/mail-queue.service';
import { RulesService } from '../rules/rules.service';
import type {
  ChecklistResponseType,
  CreateChecklistTemplateDto,
  UpdateChecklistTemplateDto,
} from './dto/checklist-template.dto';
import type { ChecklistResponseDto, SubmitChecklistDto } from './dto/submit-responses.dto';
import {
  evaluarTareaDelTurno,
  TAREA_SIN_HORA,
  type CandidatosDeVencimiento,
  type VentanaDelTurno,
} from './tarea-atrasada.policy';

/**
 * Un item marcado como falla es una novedad operativa, no un dato de reporte:
 * el extintor descargado o la puerta forzada tienen que llegarle al supervisor
 * mientras el guardia todavia esta en el recinto.
 */
const ALERTA_CHECKLIST_FALLA = {
  subject: 'Falla en checklist: {{item}} ({{site}})',
  text:
    '{{guard}} marcó como FALLA el punto "{{item}}" del checklist "{{template}}" ' +
    'en {{site}}.\n\n' +
    'Respuesta: {{value}}\n' +
    'Observación: {{notes}}\n' +
    'Hora (servidor): {{at}}\n\n' +
    'El detalle de la ronda está en el panel de VoxIA Control.',
} as const;

/**
 * Plantilla con sus items en una sola consulta; el WHERE lo pone cada llamador.
 *
 * Las tres ultimas columnas son las de la migracion de tareas del turno y no son
 * decorativas: sin `checkpoint_id` el telefono no puede saber en QUE punto se
 * responde cada tarea, y una tarea con punto que no se proyecta aca es una tarea
 * que el guardia nunca ve al escanear. Si se agrega una columna a
 * `checklist_items`, va tambien aca — hay una prueba que cruza esta proyeccion
 * contra la migracion justamente porque un mock no sabe SQL.
 */
const SELECT_PLANTILLA = `
  SELECT t.id, t.name, t.site_id, t.shift_id, t.is_active,
         COALESCE(jsonb_agg(jsonb_build_object(
           'id', i.id,
           'position', i.position,
           'label', i.label,
           'responseType', i.response_type,
           'requiresPhotoOnFail', i.requires_photo_on_fail,
           'checkpointId', i.checkpoint_id,
           'dueLocalTime', i.due_local_time,
           'requiresPhoto', i.requires_photo
         ) ORDER BY i.position) FILTER (WHERE i.id IS NOT NULL), '[]'::jsonb) AS items
  FROM checklist_templates t
  LEFT JOIN checklist_items i ON i.tenant_id = t.tenant_id AND i.template_id = t.id
`;

export interface ChecklistItemView {
  id: string;
  position: number;
  label: string;
  responseType: ChecklistResponseType;
  requiresPhotoOnFail: boolean;
  /** Donde se hace. `null` = tarea general del turno: se responde en el cierre. */
  checkpointId: string | null;
  /**
   * A que hora toca, en la zona DEL RECINTO y sin fecha ("11:00:00"), tal como
   * la guarda la columna `time`. `null` = en cualquier momento de la ronda. El
   * telefono la MUESTRA; cuanto se atraso una respuesta lo decide el servidor.
   */
  dueLocalTime: string | null;
  /** Foto siempre, este todo bien o mal. Distinta de `requiresPhotoOnFail`. */
  requiresPhoto: boolean;
}

interface FilaPlantilla {
  id: string;
  name: string;
  site_id: string | null;
  shift_id: string | null;
  is_active: boolean;
  items: ChecklistItemView[];
}

interface FilaRonda {
  id: string;
  tenant_id: string;
  site_id: string;
  shift_id: string | null;
}

interface Falla {
  responseId: string;
  item: ChecklistItemView;
  value: string;
  notes: string | undefined;
}

export type ResponseStatus = 'aplicado' | 'duplicado' | 'rechazado';

export interface ChecklistResponseResult {
  itemId: string;
  status: ResponseStatus;
  responseId?: string;
  reason?: string;
  /**
   * Minutos de atraso de una tarea CON hora. Ausente = la tarea no tenia hora
   * pedida, que no es lo mismo que cero (ver `tarea-atrasada.policy.ts`).
   *
   * Viaja de vuelta al telefono a proposito: el guardia tiene que enterarse de
   * que quedo tarde en el momento, no en el informe del mes siguiente. Es un
   * aviso, no un rechazo — la respuesta ya quedo guardada cuando esto se lee.
   */
  lateMinutes?: number;
  /** La hora de la tarea cae fuera del horario de la ronda. Se acepto igual. */
  outsideShift?: boolean;
  /** Texto ya redactado para la pantalla; la app no reimplementa el criterio. */
  lateMessage?: string;
}

/** Lo que hace falta para fechar las tareas de esta ronda, resuelto en SQL. */
interface HorarioDeLasTareas {
  readonly ahora: Date;
  readonly ventana: VentanaDelTurno;
  readonly porItem: ReadonlyMap<string, CandidatosDeVencimiento>;
}

interface FilaVencimiento {
  item_id: string;
  ahora: Date;
  ventana_inicio: Date;
  ventana_fin: Date;
  vence_del_dia: Date;
  vence_del_dia_siguiente: Date;
}

type Interpretacion =
  | { ok: true; value: string; failed: boolean }
  | { ok: false; reason: string };

@Injectable()
export class ChecklistsService {
  private readonly logger = new Logger(ChecklistsService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly mail: MailQueueService,
    private readonly rules: RulesService,
    private readonly bandeja: EventsStreamService,
  ) {}

  // ------------------------------------------------------------- plantillas

  /**
   * Sin `siteId` devuelve las plantillas de toda la empresa, que es lo que ve el
   * ADMIN. Con `siteId` devuelve solo las de ese recinto: es lo que necesita el
   * editor del SUPERVISOR, que esta acotado a sus recintos asignados y no debe
   * llegar a enumerar los nombres de las plantillas de un recinto ajeno.
   *
   * El filtro NO reemplaza al control de acceso: quien pasa el `siteId` ya
   * comprobo la asignacion (ver TareasTurnoService). Aca es solo el WHERE.
   */
  async listTemplates(siteId?: string) {
    const filas = await this.tenantContext.manager.query<FilaPlantilla[]>(
      `${SELECT_PLANTILLA}
       WHERE $1::uuid IS NULL OR t.site_id = $1::uuid
       GROUP BY t.id
       ORDER BY t.is_active DESC, t.name`,
      [siteId ?? null],
    );
    return filas.map((fila) => this.vista(fila));
  }

  async createTemplate(input: CreateChecklistTemplateDto) {
    const siteId = input.siteId ?? null;
    const shiftId = input.shiftId ?? null;
    if (shiftId !== null) {
      if (siteId === null) {
        throw new BadRequestException('Un checklist por turno necesita también el recinto');
      }
      await this.verificarTurnoDelRecinto(shiftId, siteId);
    }
    await this.verificarAlcanceLibre(siteId, shiftId, null);

    const templateId = randomUUID();
    await this.tenantContext.manager.query(
      `INSERT INTO checklist_templates (id, tenant_id, site_id, shift_id, name)
       VALUES ($1, app_tenant_id(), $2, $3, $4)`,
      [templateId, siteId, shiftId, input.name.trim()],
    );
    await this.insertarItems(templateId, input.items, siteId);

    return { id: templateId, siteId, shiftId, items: input.items.length };
  }

  /**
   * Cambiar los items de una plantilla YA RESPONDIDA reescribiria la pregunta
   * que contesto una ronda cerrada, asi que se responde 409 y el admin crea una
   * plantilla nueva. Es el mismo criterio con el que una ruta sube de version en
   * vez de mutar el historico.
   */
  async updateTemplate(templateId: string, input: UpdateChecklistTemplateDto) {
    // Se lee tambien el recinto: los items nuevos pueden traer punto y hora, y
    // ese punto tiene que ser de ESTE recinto. El alcance no se edita (ver el
    // DTO), asi que el recinto guardado es el que manda.
    const existentes = await this.tenantContext.manager.query<
      Array<{ id: string; site_id: string | null }>
    >(`SELECT id, site_id FROM checklist_templates WHERE id = $1`, [templateId]);
    const plantilla = existentes[0];
    if (!plantilla) throw new NotFoundException('El checklist no existe');
    if (input.name === undefined && input.items === undefined) {
      throw new BadRequestException('Nada que actualizar');
    }

    if (input.items) {
      const respondidas = await this.tenantContext.manager.query<Array<{ id: string }>>(
        `SELECT r.id
         FROM checklist_responses r
         JOIN checklist_items i ON i.tenant_id = r.tenant_id AND i.id = r.item_id
         WHERE i.template_id = $1
         LIMIT 1`,
        [templateId],
      );
      if (respondidas.length) {
        throw new ConflictException(
          'Este checklist ya tiene respuestas registradas: desactívalo y crea uno nuevo',
        );
      }
      await this.tenantContext.manager.query(
        `DELETE FROM checklist_items WHERE template_id = $1`,
        [templateId],
      );
      await this.insertarItems(templateId, input.items, plantilla.site_id ?? null);
    }

    await this.tenantContext.manager.query(
      `UPDATE checklist_templates
       SET name = COALESCE($2, name), updated_at = now()
       WHERE id = $1`,
      [templateId, input.name?.trim() ?? null],
    );
    return this.getTemplate(templateId);
  }

  async setTemplateActive(templateId: string, isActive: boolean) {
    const filas = await this.tenantContext.manager.query<
      Array<{ site_id: string | null; shift_id: string | null }>
    >(`SELECT site_id, shift_id FROM checklist_templates WHERE id = $1`, [templateId]);
    const plantilla = filas[0];
    if (!plantilla) throw new NotFoundException('El checklist no existe');

    // Reactivar puede chocar con la plantilla que la reemplazo: se responde 409
    // en vez de dejar que el indice unico parcial devuelva un 500.
    if (isActive) {
      await this.verificarAlcanceLibre(plantilla.site_id, plantilla.shift_id, templateId);
    }

    await this.tenantContext.manager.query(
      `UPDATE checklist_templates SET is_active = $2, updated_at = now() WHERE id = $1`,
      [templateId, isActive],
    );
    return { id: templateId, isActive };
  }

  async getTemplate(templateId: string) {
    const filas = await this.tenantContext.manager.query<FilaPlantilla[]>(
      `${SELECT_PLANTILLA}
       WHERE t.id = $1
       GROUP BY t.id`,
      [templateId],
    );
    const plantilla = filas[0];
    if (!plantilla) throw new NotFoundException('El checklist no existe');
    return this.vista(plantilla);
  }

  // -------------------------------------------------------------- ejecucion

  /** Lo que el guardia tiene que responder en esta ronda, ya resuelto. */
  async templateForPatrol(patrolId: string, guardId: string) {
    const ronda = await this.rondaDelGuardia(patrolId, guardId);
    const plantilla = await this.plantillaVigente(ronda.site_id, ronda.shift_id);
    if (!plantilla) {
      return { patrolId, hasChecklist: false as const };
    }
    return {
      patrolId,
      hasChecklist: true as const,
      template: { id: plantilla.id, name: plantilla.name, items: plantilla.items },
    };
  }

  /**
   * Guarda las respuestas. Cada item lleva su propio veredicto: uno invalido no
   * bota a los demas, porque el guardia no puede perder el checklist entero por
   * un item que llego mal desde una app vieja.
   *
   * Todos los rechazos se deciden en la aplicacion antes de tocar la base: una
   * sentencia fallida abortaria la transaccion del request y se llevaria puestas
   * las respuestas que si eran validas.
   */
  async saveResponses(patrolId: string, guardId: string, input: SubmitChecklistDto) {
    const ronda = await this.rondaDelGuardia(patrolId, guardId);
    const plantilla = await this.plantillaVigente(ronda.site_id, ronda.shift_id);
    if (!plantilla) throw new ConflictException('Esta ronda no tiene un checklist vigente');

    const items = new Map(plantilla.items.map((item) => [item.id, item] as const));
    // Solo las tareas CON hora necesitan vencimiento, y se resuelven todas de
    // una vez antes del bucle: adentro seria una consulta por item. Un checklist
    // sin horas —el caso de #129, que sigue siendo la mayoria— no paga nada.
    const horario = await this.horarioDeLasTareas(
      patrolId,
      input.responses
        .map((respuesta) => items.get(respuesta.itemId))
        .filter((item): item is ChecklistItemView => Boolean(item?.dueLocalTime))
        .map((item) => item.id),
    );
    const results: ChecklistResponseResult[] = [];
    const fallas: Falla[] = [];

    for (const respuesta of input.responses) {
      const item = items.get(respuesta.itemId);
      if (!item) {
        results.push(rechazo(respuesta.itemId, 'El item no pertenece al checklist de esta ronda'));
        continue;
      }

      const interpretada = interpretar(item, respuesta);
      if (!interpretada.ok) {
        results.push(rechazo(respuesta.itemId, interpretada.reason));
        continue;
      }

      if (item.requiresPhotoOnFail && interpretada.failed && !respuesta.photoId) {
        results.push(rechazo(respuesta.itemId, 'Este item exige foto cuando se marca falla'));
        continue;
      }
      if (respuesta.photoId && !(await this.fotoDeLaRonda(respuesta.photoId, patrolId))) {
        results.push(rechazo(respuesta.itemId, 'La foto no pertenece a esta ronda'));
        continue;
      }

      // Llegar tarde NO es motivo de rechazo: el requisito es textual —"si la
      // tarea queda fuera del horario de la ronda, que se envie igual". Por eso
      // esto se evalua DESPUES de todos los rechazos y no agrega ninguno.
      const veredicto =
        horario && item.dueLocalTime
          ? evaluarTareaDelTurno({
              candidatos: horario.porItem.get(item.id) ?? null,
              ventana: horario.ventana,
              respondidaA: horario.ahora,
            })
          : TAREA_SIN_HORA;

      const insertadas = await this.tenantContext.manager.query<Array<{ id: string }>>(
        `INSERT INTO checklist_responses (
          tenant_id, patrol_id, item_id, value, notes, failed, photo_id, late_minutes
        ) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (tenant_id, patrol_id, item_id) DO NOTHING
        RETURNING id`,
        [
          patrolId,
          item.id,
          interpretada.value,
          respuesta.notes?.trim() ?? null,
          interpretada.failed,
          respuesta.photoId ?? null,
          // Se escribe en el INSERT o no se escribe nunca: voxia_app tiene
          // REVOKE UPDATE sobre checklist_responses, asi que no existe la opcion
          // de "calcularlo despues".
          veredicto.minutosDeAtraso,
        ],
      );
      const guardada = insertadas[0];
      if (!guardada) {
        // Reenvio del lote offline: la primera respuesta manda y no se reescribe.
        results.push({ itemId: item.id, status: 'duplicado' });
        continue;
      }

      results.push({
        itemId: item.id,
        status: 'aplicado',
        responseId: guardada.id,
        // Ausentes cuando la tarea no tenia hora: mandar `lateMinutes: 0` diria
        // "la hiciste a tiempo" de algo que nunca tuvo hora.
        ...(veredicto.minutosDeAtraso === null
          ? {}
          : {
              lateMinutes: veredicto.minutosDeAtraso,
              outsideShift: veredicto.fueraDelTurno,
              lateMessage: veredicto.mensaje ?? undefined,
            }),
      });
      if (interpretada.failed) {
        fallas.push({
          responseId: guardada.id,
          item,
          value: interpretada.value,
          notes: respuesta.notes,
        });
      }
    }

    // Primero la bandeja en vivo, que es en memoria y no puede fallar; el correo
    // depende de Redis y de un servidor SMTP.
    for (const falla of fallas) {
      this.bandeja.publish(ronda.tenant_id, {
        type: 'checklist_falla',
        siteId: ronda.site_id,
        responseId: falla.responseId,
        patrolId,
        itemLabel: falla.item.label,
        respondedAt: new Date().toISOString(),
      });
    }

    const notified = await this.avisarFallas(ronda, guardId, plantilla.name, fallas);
    // `late` es el resumen que la pantalla necesita para el aviso de arriba sin
    // recorrer los items; el detalle de cada uno va en su propio result.
    const late = results.filter((resultado) => (resultado.lateMinutes ?? 0) > 0).length;
    return { patrolId, templateId: plantilla.id, failed: fallas.length, late, notified, results };
  }

  // ----------------------------------------------------------------- apoyo

  /**
   * Gana la plantilla mas especifica: recinto + turno, luego recinto, luego la
   * de toda la empresa. El indice unico parcial garantiza que no haya dos
   * activas con el mismo alcance, asi que no hay empate que desempatar.
   */
  private async plantillaVigente(siteId: string, shiftId: string | null) {
    const filas = await this.tenantContext.manager.query<FilaPlantilla[]>(
      `${SELECT_PLANTILLA}
       WHERE t.is_active
         AND (t.site_id IS NULL OR t.site_id = $1)
         AND (t.shift_id IS NULL OR t.shift_id = $2)
       GROUP BY t.id
       ORDER BY (t.site_id IS NOT NULL)::int + (t.shift_id IS NOT NULL)::int DESC
       LIMIT 1`,
      [siteId, shiftId],
    );
    return filas[0];
  }

  private async rondaDelGuardia(patrolId: string, guardId: string): Promise<FilaRonda> {
    const filas = await this.tenantContext.manager.query<FilaRonda[]>(
      `SELECT p.id, p.tenant_id, p.site_id, a.shift_id
       FROM patrols p
       LEFT JOIN shift_assignments a
         ON a.tenant_id = p.tenant_id AND a.id = p.shift_assignment_id
       WHERE p.id = $1 AND p.guard_id = $2`,
      [patrolId, guardId],
    );
    const ronda = filas[0];
    if (!ronda) throw new NotFoundException('La ronda asignada no existe');
    // La ronda cerrada acepta respuestas igual: el lote offline puede llegar
    // despues del escaneo de cierre y esas respuestas no se pueden perder.
    return ronda;
  }

  /**
   * Vencimiento de cada tarea con hora, resuelto ENTERO por PostgreSQL.
   *
   * Tres cosas que no son obvias y que costaron dias en otros carriles:
   *
   * 1. La zona no se toca en JavaScript. `due_local_time` es hora de pared del
   *    recinto y convertirla sin la tzdata obliga a un offset fijo que esta mal
   *    la mitad del año (ver `scheduling.service.ts`). Se arma primero el
   *    timestamp SIN zona (`service_day + due_local_time`) y recien despues se
   *    convierte con `AT TIME ZONE`: al reves se corre una hora en cada cambio
   *    de horario.
   *
   * 2. Se devuelven DOS candidatos, no uno. Una hora de pared sola no dice a que
   *    dia pertenece cuando el turno cruza medianoche, y elegir es una decision
   *    de producto que se prueba sin base de datos: la toma
   *    `tarea-atrasada.policy.ts`. El `+ INTERVAL '1 day'` se aplica al
   *    timestamp sin zona por el mismo motivo del punto 1 — significa "el mismo
   *    reloj de pared del dia siguiente", no "24 horas despues".
   *
   * 3. `now()` es la hora de INICIO de la transaccion, y el request entero corre
   *    en una sola transaccion (`TenantContextInterceptor`). Asi que este
   *    `ahora` es EXACTAMENTE el que el INSERT dejara en `responded_at`:
   *    `late_minutes` y `responded_at` no pueden contarse historias distintas.
   *    Es tambien la razon de medir contra el reloj del servidor y no contra el
   *    del telefono: `checklist_responses` no guarda hora del dispositivo ni
   *    medicion de desfase, y aceptar la del telefono sin corregirla (ver
   *    `sync/device-clock.ts`) dejaria que atrasar el reloj sirviera para llegar
   *    siempre a tiempo.
   *
   * La ventana de referencia es la del TURNO cuando la ronda cuelga de una
   * asignacion —el turno es el contenedor, igual que en `app_stats_service_day`—
   * y la de la propia ronda cuando no. Con la ventana de la ronda, una tarea de
   * las 23:00 quedaria "fuera de horario" en todas las rondas del turno menos en
   * una.
   */
  private async horarioDeLasTareas(
    patrolId: string,
    itemIds: readonly string[],
  ): Promise<HorarioDeLasTareas | null> {
    if (!itemIds.length) return null;

    const filas = await this.tenantContext.manager.query<FilaVencimiento[]>(
      `WITH ronda AS (
         SELECT p.tenant_id,
                p.scheduled_start_at,
                p.scheduled_end_at,
                si.timezone,
                a.service_date,
                s.starts_at,
                s.ends_at
         FROM patrols p
         JOIN sites si ON si.tenant_id = p.tenant_id AND si.id = p.site_id
         LEFT JOIN shift_assignments a
           ON a.tenant_id = p.tenant_id AND a.id = p.shift_assignment_id
         LEFT JOIN shifts s ON s.tenant_id = a.tenant_id AND s.id = a.shift_id
         WHERE p.id = $1
       ),
       dia AS (
         SELECT r.*,
                app_stats_service_day(r.scheduled_start_at, r.service_date, r.timezone)
                  AS service_day
         FROM ronda r
       )
       SELECT i.id AS item_id,
              now() AS ahora,
              COALESCE(((d.service_day + d.starts_at) AT TIME ZONE d.timezone),
                       d.scheduled_start_at) AS ventana_inicio,
              COALESCE(((d.service_day + d.ends_at
                         + CASE WHEN d.ends_at <= d.starts_at
                                THEN INTERVAL '1 day' ELSE INTERVAL '0 day' END
                        ) AT TIME ZONE d.timezone),
                       d.scheduled_end_at) AS ventana_fin,
              ((d.service_day + i.due_local_time) AT TIME ZONE d.timezone) AS vence_del_dia,
              (((d.service_day + i.due_local_time) + INTERVAL '1 day') AT TIME ZONE d.timezone)
                AS vence_del_dia_siguiente
       FROM dia d
       JOIN checklist_items i
         ON i.tenant_id = d.tenant_id AND i.id = ANY($2::uuid[])
       WHERE i.due_local_time IS NOT NULL`,
      [patrolId, [...itemIds]],
    );

    // Sin filas no se inventa un vencimiento: la tarea se guarda con
    // `late_minutes` NULL. Falla hacia "no hay atraso medido", nunca hacia un
    // atraso adivinado que despues alguien tendria que explicar en un informe.
    const primera = filas[0];
    if (!primera) return null;

    return {
      ahora: primera.ahora,
      ventana: { inicio: primera.ventana_inicio, fin: primera.ventana_fin },
      porItem: new Map(
        filas.map((fila) => [
          fila.item_id,
          { delDia: fila.vence_del_dia, delDiaSiguiente: fila.vence_del_dia_siguiente },
        ]),
      ),
    };
  }

  private async fotoDeLaRonda(photoId: string, patrolId: string): Promise<boolean> {
    const filas = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `SELECT id FROM scan_photos WHERE id = $1 AND patrol_id = $2`,
      [photoId, patrolId],
    );
    return filas.length > 0;
  }

  private async verificarTurnoDelRecinto(shiftId: string, siteId: string) {
    const filas = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `SELECT id FROM shifts WHERE id = $1 AND site_id = $2`,
      [shiftId, siteId],
    );
    if (!filas.length) {
      throw new BadRequestException('El turno no pertenece a ese recinto');
    }
  }

  private async verificarAlcanceLibre(
    siteId: string | null,
    shiftId: string | null,
    exceptoTemplateId: string | null,
  ) {
    const filas = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `SELECT id FROM checklist_templates
       WHERE is_active
         AND site_id IS NOT DISTINCT FROM $1
         AND shift_id IS NOT DISTINCT FROM $2
         AND ($3::uuid IS NULL OR id <> $3)`,
      [siteId, shiftId, exceptoTemplateId],
    );
    if (filas.length) {
      throw new ConflictException('Ya existe un checklist vigente para ese alcance');
    }
  }

  /**
   * Una tarea con LUGAR u HORA solo tiene sentido dentro de un recinto (#265).
   *
   * El punto: la FK compuesta de la migracion garantiza que el punto sea del
   * mismo tenant, NO que sea de este recinto. Sin esta comprobacion se puede
   * guardar una tarea colgada de un punto de otra sucursal, que ninguna ronda de
   * este recinto va a escanear nunca: una tarea que se ve en el editor y no
   * existe en terreno.
   *
   * La hora: `due_local_time` es hora local del recinto y se resuelve con
   * `sites.timezone`. Una plantilla de toda la empresa no tiene una sola zona,
   * asi que "11:00" ahi no significa nada.
   *
   * Se rechaza ANTES de cualquier INSERT a proposito: una sentencia que falla
   * aborta la transaccion completa del request, y el 400 de un item se llevaria
   * por delante el UPDATE de la plantilla.
   */
  private async verificarLugarYHora(
    items: CreateChecklistTemplateDto['items'],
    siteId: string | null,
  ) {
    /*
     * `Boolean(...)` y NO `!== undefined`: los DTO usan `@IsOptional()`, que
     * acepta `undefined` Y `null`, y un formulario web manda `null` para "sin
     * punto" —no omite la clave—. Con `!== undefined`, una tarea sin punto de
     * una plantilla de toda la empresa entraba en este filtro y se llevaba un
     * 400 que no correspondia: "necesita una plantilla de recinto", cuando
     * justamente no habia pedido ningun recinto.
     */
    const conLugarUHora = items.filter(
      (item) => Boolean(item.checkpointId) || Boolean(item.dueLocalTime),
    );
    if (!conLugarUHora.length) return;
    if (siteId === null) {
      throw new BadRequestException(
        'Una tarea con punto de control u hora necesita una plantilla de recinto',
      );
    }

    const puntos = [
      ...new Set(
        conLugarUHora
          .map((item) => item.checkpointId)
          // Igual que arriba: `null` es "sin punto", no un punto a validar.
          // Colarlo aqui mandaria un null dentro del arreglo de uuid a
          // PostgreSQL, que es un error en la base y no una validacion.
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    if (!puntos.length) return;

    // `= ANY($1::uuid[])` sobre la columna uuid, con el casteo escrito: es el
    // arreglo el que se compara contra la columna, no la columna contra un
    // documento. Un `= ANY(...)` mal tipado compila en TypeScript y revienta en
    // la base, que es como se perdio un endpoint entero en produccion.
    const encontrados = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `SELECT id FROM checkpoints
       WHERE id = ANY($1::uuid[]) AND site_id = $2 AND is_active`,
      [puntos, siteId],
    );
    if (encontrados.length !== puntos.length) {
      throw new BadRequestException(
        'Un punto de control de la tarea no pertenece al recinto o está inactivo',
      );
    }
  }

  private async insertarItems(
    templateId: string,
    items: CreateChecklistTemplateDto['items'],
    siteId: string | null,
  ) {
    await this.verificarLugarYHora(items, siteId);
    for (const [indice, item] of items.entries()) {
      await this.tenantContext.manager.query(
        `INSERT INTO checklist_items (
          tenant_id, template_id, position, label, response_type, requires_photo_on_fail,
          checkpoint_id, due_local_time, requires_photo
        ) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7::time, $8)`,
        [
          templateId,
          indice + 1,
          item.label.trim(),
          item.responseType,
          item.requiresPhotoOnFail ?? false,
          item.checkpointId ?? null,
          item.dueLocalTime ?? null,
          item.requiresPhoto ?? false,
        ],
      );
    }
  }

  /** Un fallo de correo JAMAS puede botar la respuesta ya registrada. */
  private async avisarFallas(
    ronda: FilaRonda,
    guardId: string,
    plantilla: string,
    fallas: readonly Falla[],
  ): Promise<number> {
    if (!fallas.length) return 0;

    try {
      // Que una falla avise por correo es configuracion del tenant: hay empresas
      // que quieren el correo y otras que solo miran la bandeja.
      const reglas = await this.rules.effective();
      if (!reglas.checklistFailureNotify) return 0;

      const destinatarios = await this.tenantContext.manager.query<
        Array<{ id: string; email: string }>
      >(
        `SELECT u.id, u.email
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         JOIN supervisor_sites ss
           ON ss.supervisor_id = m.user_id AND ss.site_id = $1
         WHERE m.role_key = 'SUPERVISOR' AND u.is_active AND u.email IS NOT NULL`,
        [ronda.site_id],
      );
      if (!destinatarios.length) {
        this.logger.warn(
          JSON.stringify({
            event: 'checklist_falla_sin_destinatarios',
            tenant_id: ronda.tenant_id,
          }),
        );
        return 0;
      }

      const contexto = await this.tenantContext.manager.query<
        Array<{ site_name: string; guard_name: string }>
      >(
        `SELECT s.name AS site_name,
                (u.given_name || ' ' || u.family_name) AS guard_name
         FROM sites s, users u
         WHERE s.id = $1 AND u.id = $2`,
        [ronda.site_id, guardId],
      );
      const info = contexto[0];
      if (!info) return 0;

      let enviados = 0;
      for (const falla of fallas) {
        const vars = {
          item: falla.item.label,
          template: plantilla,
          site: info.site_name,
          guard: info.guard_name,
          value: falla.value,
          notes: falla.notes?.trim() ?? '(sin observación)',
          at: new Date().toISOString(),
        };
        for (const destino of destinatarios) {
          const encolado = await this.mail.enqueue(
            {
              to: destino.email,
              template: ALERTA_CHECKLIST_FALLA,
              variables: vars,
              tenantId: ronda.tenant_id,
            },
            { idempotencyKey: `checklist-fail:${falla.responseId}:${destino.email}` },
          );
          // Un destinatario suprimido por dominio (#86) NO cuenta como enviado:
          // este numero es lo unico que dice si el aviso salio, y contarlo
          // convertiria la unica senal disponible en una mentira.
          if (encolado.estado === 'encolado') enviados += 1;
        }
      }
      return enviados;
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'checklist_falla_aviso_fallo',
          tenant_id: ronda.tenant_id,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return 0;
    }
  }

  private vista(fila: FilaPlantilla) {
    return {
      id: fila.id,
      name: fila.name,
      siteId: fila.site_id,
      shiftId: fila.shift_id,
      isActive: fila.is_active,
      items: fila.items,
    };
  }
}

function rechazo(itemId: string, reason: string): ChecklistResponseResult {
  return { itemId, status: 'rechazado', reason };
}

/**
 * En 'ok_falla' la falla la decide el servidor a partir del valor; en 'texto' y
 * 'numero' la declara quien responde, porque solo el sabe si 3 bar de presion
 * son normales en ese extintor.
 */
function interpretar(item: ChecklistItemView, respuesta: ChecklistResponseDto): Interpretacion {
  const valor = respuesta.value.trim();
  if (!valor) return { ok: false, reason: 'La respuesta viene vacía' };

  if (item.responseType === 'ok_falla') {
    const normalizado = valor.toLowerCase();
    if (normalizado !== 'ok' && normalizado !== 'falla') {
      return { ok: false, reason: 'Este item solo admite "ok" o "falla"' };
    }
    return { ok: true, value: normalizado, failed: normalizado === 'falla' };
  }

  if (item.responseType === 'numero' && !Number.isFinite(Number(valor))) {
    return { ok: false, reason: 'Este item espera un número' };
  }

  return { ok: true, value: valor, failed: respuesta.failed ?? false };
}
