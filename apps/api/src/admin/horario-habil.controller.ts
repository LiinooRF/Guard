import { Controller, Get, Param, Query } from '@nestjs/common';

import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { ComprobarHorarioQuery, RecintoParam } from './dto/horario-habil.dto';
import { HorarioHabilService } from './horario-habil.service';

/**
 * Comprobacion del horario habil de un recinto (#68).
 *
 * Mismo permiso y mismo alcance que el resto del calendario del recinto
 * (`tenant:sites:manage`, solo ADMIN, dentro del tenant): quien puede editar el
 * horario es quien puede comprobarlo. El SUPERVISOR no entra aca — no configura
 * recintos — asi que no hay filtro por supervisor_sites que aplicar.
 *
 * Va en su propio controlador para no tocar AdminController ni el constructor
 * de AdminService, que ya tienen dueño en otro carril.
 */
@Controller('admin')
@TenantScope()
export class HorarioHabilController {
  constructor(private readonly horario: HorarioHabilService) {}

  @Get('sites/:siteId/business-hours/check')
  @Permissions('tenant:sites:manage')
  comprobarHorario(@Param() params: RecintoParam, @Query() query: ComprobarHorarioQuery) {
    return this.horario.comprobar(params.siteId, query.date, query.time);
  }
}
