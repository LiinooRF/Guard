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

/** Plantilla con sus items en una sola consulta; el WHERE lo pone cada llamador. */
const SELECT_PLANTILLA = `
  SELECT t.id, t.name, t.site_id, t.shift_id, t.is_active,
         COALESCE(jsonb_agg(jsonb_build_object(
           'id', i.id,
           'position', i.position,
           'label', i.label,
           'responseType', i.response_type,
           'requiresPhotoOnFail', i.requires_photo_on_fail
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

  async listTemplates() {
    const filas = await this.tenantContext.manager.query<FilaPlantilla[]>(
      `${SELECT_PLANTILLA}
       GROUP BY t.id
       ORDER BY t.is_active DESC, t.name`,
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
    await this.insertarItems(templateId, input.items);

    return { id: templateId, siteId, shiftId, items: input.items.length };
  }

  /**
   * Cambiar los items de una plantilla YA RESPONDIDA reescribiria la pregunta
   * que contesto una ronda cerrada, asi que se responde 409 y el admin crea una
   * plantilla nueva. Es el mismo criterio con el que una ruta sube de version en
   * vez de mutar el historico.
   */
  async updateTemplate(templateId: string, input: UpdateChecklistTemplateDto) {
    const existentes = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `SELECT id FROM checklist_templates WHERE id = $1`,
      [templateId],
    );
    if (!existentes.length) throw new NotFoundException('El checklist no existe');
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
      await this.insertarItems(templateId, input.items);
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

      const insertadas = await this.tenantContext.manager.query<Array<{ id: string }>>(
        `INSERT INTO checklist_responses (
          tenant_id, patrol_id, item_id, value, notes, failed, photo_id
        ) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6)
        ON CONFLICT (tenant_id, patrol_id, item_id) DO NOTHING
        RETURNING id`,
        [
          patrolId,
          item.id,
          interpretada.value,
          respuesta.notes?.trim() ?? null,
          interpretada.failed,
          respuesta.photoId ?? null,
        ],
      );
      const guardada = insertadas[0];
      if (!guardada) {
        // Reenvio del lote offline: la primera respuesta manda y no se reescribe.
        results.push({ itemId: item.id, status: 'duplicado' });
        continue;
      }

      results.push({ itemId: item.id, status: 'aplicado', responseId: guardada.id });
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
    return { patrolId, templateId: plantilla.id, failed: fallas.length, notified, results };
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

  private async insertarItems(
    templateId: string,
    items: CreateChecklistTemplateDto['items'],
  ) {
    for (const [indice, item] of items.entries()) {
      await this.tenantContext.manager.query(
        `INSERT INTO checklist_items (
          tenant_id, template_id, position, label, response_type, requires_photo_on_fail
        ) VALUES (app_tenant_id(), $1, $2, $3, $4, $5)`,
        [
          templateId,
          indice + 1,
          item.label.trim(),
          item.responseType,
          item.requiresPhotoOnFail ?? false,
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
          await this.mail.enqueue(
            {
              to: destino.email,
              template: ALERTA_CHECKLIST_FALLA,
              variables: vars,
              tenantId: ronda.tenant_id,
            },
            { idempotencyKey: `checklist-fail:${falla.responseId}:${destino.email}` },
          );
          enviados += 1;
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
