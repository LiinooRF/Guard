import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { SupervisorService } from '../supervisor/supervisor.service';
import { ChecklistsService } from './checklists.service';
import type { UpdateChecklistTemplateDto } from './dto/checklist-template.dto';
import type { CrearTareasTurnoDto } from './dto/tarea-turno.dto';

interface FilaCatalogo {
  id: string;
  name: string;
  branch_name: string;
  timezone: string;
  checkpoints: Array<{ id: string; name: string }>;
  shifts: Array<{ id: string; name: string; startsAt: string; endsAt: string }>;
}

/**
 * El editor de tareas del turno, del lado del SUPERVISOR (#265).
 *
 * Existe separado de `ChecklistsService` por una sola razon, y es de acceso:
 * aquel servicio no sabe quien pide, opera sobre el tenant entero y es el que
 * usa el ADMIN. El SUPERVISOR **no** puede operar sobre el tenant entero — esta
 * limitado a sus recintos asignados (`supervisor_sites`), y eso se verifica
 * aparte del permiso, en cada metodo. Es la regla del repo para ese rol: el rol
 * no basta.
 *
 * Lo que este servicio NO deja hacer, a proposito:
 *
 * · **Plantillas de toda la empresa** (`site_id IS NULL`). Son de alcance
 *   tenant, o sea de todos los recintos incluidos los que este supervisor no
 *   tiene; y ademas una hora local sin recinto no tiene zona con la que
 *   resolverse. Se responde 403, no 404: la plantilla existe, no es suya.
 * · **Mover el alcance.** El DTO de edicion ya no acepta recinto ni turno, asi
 *   que una plantilla no puede migrar a un recinto ajeno editandola.
 *
 * El aislamiento entre empresas no descansa en esto sino en RLS: una plantilla
 * de otro tenant no la devuelve la consulta, asi que el cruce de empresas
 * termina en 404 antes de llegar a la comprobacion de recinto.
 */
@Injectable()
export class TareasTurnoService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly checklists: ChecklistsService,
    private readonly supervisor: SupervisorService,
  ) {}

  /**
   * Todo lo que el formulario necesita, en una sola consulta: los recintos
   * asignados con su ZONA HORARIA, sus puntos de control y sus turnos.
   *
   * La zona es la razon de que este catalogo exista en vez de reusar
   * `GET /supervisor/route-editor/sites`: ese payload no la trae, y sin zona la
   * hora de una tarea ("a las 11") no significa nada. Reusarlo ademas ataria el
   * editor de tareas al permiso `routes:manage`, que es de otra pantalla.
   *
   * No lleva `ensureAssignedSite` porque es justamente la consulta que RESUELVE
   * cuales son sus recintos: el JOIN con `supervisor_sites` es el filtro.
   */
  async catalogo(supervisorId: string) {
    // Sub-consultas LATERAL y no dos LEFT JOIN: puntos por turnos es un producto
    // cartesiano, y `jsonb_agg(DISTINCT ...)` para deshacerlo obliga a ordenar
    // por la misma expresion que se destila, o sea a perder el orden util.
    const filas = await this.tenantContext.manager.query<FilaCatalogo[]>(
      `SELECT s.id, s.name, s.branch_name, s.timezone,
              puntos.items AS checkpoints, turnos.items AS shifts
       FROM supervisor_sites ss
       JOIN sites s ON s.tenant_id = ss.tenant_id AND s.id = ss.site_id AND s.is_active
       LEFT JOIN LATERAL (
         SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name)
                ORDER BY c.suggested_order, c.name), '[]'::jsonb) AS items
         FROM checkpoints c WHERE c.site_id = s.id AND c.is_active
       ) puntos ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(jsonb_agg(jsonb_build_object(
                  'id', sh.id, 'name', sh.name,
                  'startsAt', left(sh.starts_at::text, 5),
                  'endsAt', left(sh.ends_at::text, 5)
                ) ORDER BY sh.starts_at), '[]'::jsonb) AS items
         FROM shifts sh WHERE sh.site_id = s.id AND sh.is_active
       ) turnos ON true
       WHERE ss.supervisor_id = $1
       ORDER BY s.branch_name, s.name`,
      [supervisorId],
    );
    return filas.map((fila) => ({
      id: fila.id,
      name: fila.name,
      branchName: fila.branch_name,
      timezone: fila.timezone,
      checkpoints: fila.checkpoints,
      shifts: fila.shifts,
    }));
  }

  async listTemplates(siteId: string, supervisorId: string) {
    await this.supervisor.ensureAssignedSite(siteId, supervisorId);
    return this.checklists.listTemplates(siteId);
  }

  /**
   * El recinto sale de la URL —la que se comprobo— y se le impone al servicio.
   * `CrearTareasTurnoDto` no tiene `siteId`, asi que no hay un segundo recinto
   * en el cuerpo que pudiera ganarle a este.
   */
  async createTemplate(siteId: string, supervisorId: string, input: CrearTareasTurnoDto) {
    await this.supervisor.ensureAssignedSite(siteId, supervisorId);
    return this.checklists.createTemplate({
      name: input.name,
      siteId,
      ...(input.shiftId === undefined ? {} : { shiftId: input.shiftId }),
      items: input.items,
    });
  }

  async getTemplate(templateId: string, supervisorId: string) {
    await this.asegurarPlantillaDelSupervisor(templateId, supervisorId);
    return this.checklists.getTemplate(templateId);
  }

  async updateTemplate(
    templateId: string,
    supervisorId: string,
    input: UpdateChecklistTemplateDto,
  ) {
    await this.asegurarPlantillaDelSupervisor(templateId, supervisorId);
    return this.checklists.updateTemplate(templateId, input);
  }

  async setTemplateActive(templateId: string, supervisorId: string, isActive: boolean) {
    await this.asegurarPlantillaDelSupervisor(templateId, supervisorId);
    return this.checklists.setTemplateActive(templateId, isActive);
  }

  /**
   * 404 si no existe (o es de otra empresa: eso lo tapa RLS antes),
   * 403 si existe pero su recinto no es de este supervisor.
   */
  private async asegurarPlantillaDelSupervisor(templateId: string, supervisorId: string) {
    const filas = await this.tenantContext.manager.query<Array<{ site_id: string | null }>>(
      `SELECT site_id FROM checklist_templates WHERE id = $1`,
      [templateId],
    );
    const plantilla = filas[0];
    if (!plantilla) throw new NotFoundException('El checklist no existe');
    if (plantilla.site_id === null) {
      throw new ForbiddenException(
        'Las tareas que aplican a toda la empresa las administra el administrador',
      );
    }
    await this.supervisor.ensureAssignedSite(plantilla.site_id, supervisorId);
  }
}
