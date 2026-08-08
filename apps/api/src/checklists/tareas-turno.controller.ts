import { Body, Controller, Get, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Request } from 'express';

import { UpdateActiveDto } from '../admin/dto/update-active.dto';
import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { UpdateChecklistTemplateDto } from './dto/checklist-template.dto';
import { CrearTareasTurnoDto } from './dto/tarea-turno.dto';
import { TareasTurnoService } from './tareas-turno.service';

class SiteParam {
  @IsUUID()
  siteId!: string;
}

class TemplateParam {
  @IsUUID()
  templateId!: string;
}

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * El editor de tareas del turno del SUPERVISOR (#265).
 *
 * Va en su propio controlador y no como cinco rutas mas en `ChecklistsController`
 * por dos motivos:
 *
 * 1. **El permiso es otro.** Estas rutas piden `checklists:manage`, que es del
 *    SUPERVISOR; las de `ChecklistsController` piden `tenant:rules:manage`, que
 *    es del ADMIN. Los permisos se comprueban con Y logico, asi que un endpoint
 *    no puede pedir "uno u otro": las dos puertas tienen que existir por
 *    separado. Cambiar el permiso de las rutas del ADMIN habria dejado al ADMIN
 *    **sin** acceso a la configuracion de checklists, porque `checklists:manage`
 *    no esta en su rol (packages/shared/src/permissions.ts, contrato congelado).
 * 2. **El alcance es otro.** Cada ruta de aca comprueba `supervisor_sites` antes
 *    de tocar nada. Las del ADMIN operan sobre el tenant completo, que es lo que
 *    corresponde a ese rol.
 *
 * Las rutas cuelgan de `checklists/supervisor/...` y no chocan con
 * `checklists/templates/...` ni `checklists/patrols/...`: el primer segmento las
 * separa, asi que el orden de registro de los controladores da igual.
 *
 * El id del supervisor sale SIEMPRE de `request.user.sub` (el token), nunca de
 * la URL: un id de supervisor en la URL seria pedirle al cliente que declare a
 * nombre de quien consulta.
 */
@Controller('checklists/supervisor')
@TenantScope()
export class TareasTurnoController {
  constructor(private readonly tareas: TareasTurnoService) {}

  /** Recintos asignados con su zona horaria, sus puntos y sus turnos. */
  @Get('sites')
  @Permissions('checklists:manage')
  catalogSites(@Req() request: Autenticado) {
    return this.tareas.catalogo(request.user.sub);
  }

  @Get('sites/:siteId/templates')
  @Permissions('checklists:manage')
  listTemplates(@Param() params: SiteParam, @Req() request: Autenticado) {
    return this.tareas.listTemplates(params.siteId, request.user.sub);
  }

  @Post('sites/:siteId/templates')
  @Permissions('checklists:manage')
  createTemplate(
    @Param() params: SiteParam,
    @Body() input: CrearTareasTurnoDto,
    @Req() request: Autenticado,
  ) {
    return this.tareas.createTemplate(params.siteId, request.user.sub, input);
  }

  @Get('templates/:templateId')
  @Permissions('checklists:manage')
  getTemplate(@Param() params: TemplateParam, @Req() request: Autenticado) {
    return this.tareas.getTemplate(params.templateId, request.user.sub);
  }

  @Put('templates/:templateId')
  @Permissions('checklists:manage')
  updateTemplate(
    @Param() params: TemplateParam,
    @Body() input: UpdateChecklistTemplateDto,
    @Req() request: Autenticado,
  ) {
    return this.tareas.updateTemplate(params.templateId, request.user.sub, input);
  }

  @Patch('templates/:templateId/active')
  @Permissions('checklists:manage')
  setTemplateActive(
    @Param() params: TemplateParam,
    @Body() input: UpdateActiveDto,
    @Req() request: Autenticado,
  ) {
    return this.tareas.setTemplateActive(params.templateId, request.user.sub, input.isActive);
  }
}
