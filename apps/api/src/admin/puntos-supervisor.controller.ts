import { Body, Controller, Delete, Get, Param, Patch, Post, Req } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { PuntosSupervisorService } from './puntos-supervisor.service';
import { RegisterTagDto } from './dto/register-tag.dto';
import { UpdateActiveDto } from './dto/update-active.dto';
import {
  CrearPuntoSupervisorDto,
  EditarPuntoSupervisorDto,
  ImportarPuntosSupervisorDto,
} from './dto/punto-supervisor.dto';

class SiteParam {
  @IsUUID()
  siteId!: string;
}

class CheckpointParam {
  @IsUUID()
  checkpointId!: string;
}

class TagParam {
  @IsUUID()
  tagId!: string;
}

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * Puntos de control y etiquetas NFC para el SUPERVISOR (#309).
 *
 * Va en su propio controlador y no como ocho rutas mas en `AdminController` por
 * dos motivos, los mismos que documenta `TareasTurnoController` para #265:
 *
 * 1. **El permiso es otro.** Estas rutas piden `checkpoints:manage`, que es del
 *    SUPERVISOR; las de `AdminController` piden `tenant:sites:manage`, que es
 *    del ADMIN. Los permisos se comprueban con Y logico (auth.guard.ts:76), asi
 *    que un endpoint no puede pedir "uno u otro": las dos puertas tienen que
 *    existir por separado. Cambiar el permiso de las rutas del ADMIN lo habria
 *    dejado a el afuera, porque `checkpoints:manage` no esta en su rol.
 * 2. **El alcance es otro.** Cada ruta de aca comprueba `supervisor_sites` antes
 *    de tocar nada. Las del ADMIN operan sobre el tenant completo, que es lo que
 *    corresponde a ese rol. El diff de `AdminController` sobre puntos y
 *    etiquetas es, a proposito, solo el actor de auditoria: nada de lo que hoy
 *    funciona se ensancha ni se rompe por este cambio.
 *
 * Las rutas cuelgan de `checkpoints/supervisor/...`: primer segmento distinto de
 * `admin/...` y de `supervisor/...`, asi que el orden de registro de los
 * controladores da igual y ninguna ruta puede quedar tapada por otra.
 *
 * El id del supervisor sale SIEMPRE de `request.user.sub` (el token), nunca de
 * la URL ni del cuerpo: un id de supervisor en la URL seria pedirle al cliente
 * que declare a nombre de quien escribe.
 *
 * Lo que NO esta aca y no es un olvido: el CRUD de recintos, el horario habil y
 * los feriados, el override de foto, el QR de respaldo y `tags/resolve`. Ver el
 * encabezado de `PuntosSupervisorService` para el motivo de cada uno.
 */
@Controller('checkpoints/supervisor')
@TenantScope()
export class PuntosSupervisorController {
  constructor(private readonly puntos: PuntosSupervisorService) {}

  @Get('sites/:siteId/checkpoints')
  @Permissions('checkpoints:manage')
  listCheckpoints(@Param() params: SiteParam, @Req() request: Autenticado) {
    return this.puntos.listCheckpoints(params.siteId, request.user.sub);
  }

  @Post('sites/:siteId/checkpoints')
  @Permissions('checkpoints:manage')
  createCheckpoint(
    @Param() params: SiteParam,
    @Body() input: CrearPuntoSupervisorDto,
    @Req() request: Autenticado,
  ) {
    return this.puntos.createCheckpoint(params.siteId, request.user.sub, input);
  }

  @Post('sites/:siteId/checkpoints/import')
  @Permissions('checkpoints:manage')
  importCheckpoints(
    @Param() params: SiteParam,
    @Body() input: ImportarPuntosSupervisorDto,
    @Req() request: Autenticado,
  ) {
    return this.puntos.importCheckpoints(params.siteId, request.user.sub, input.checkpoints);
  }

  @Patch('checkpoints/:checkpointId')
  @Permissions('checkpoints:manage')
  updateCheckpoint(
    @Param() params: CheckpointParam,
    @Body() input: EditarPuntoSupervisorDto,
    @Req() request: Autenticado,
  ) {
    return this.puntos.updateCheckpoint(params.checkpointId, request.user.sub, input);
  }

  @Patch('checkpoints/:checkpointId/active')
  @Permissions('checkpoints:manage')
  setCheckpointActive(
    @Param() params: CheckpointParam,
    @Body() input: UpdateActiveDto,
    @Req() request: Autenticado,
  ) {
    return this.puntos.setCheckpointActive(params.checkpointId, request.user.sub, input.isActive);
  }

  @Get('checkpoints/:checkpointId/tags')
  @Permissions('checkpoints:manage')
  listTags(@Param() params: CheckpointParam, @Req() request: Autenticado) {
    return this.puntos.listTags(params.checkpointId, request.user.sub);
  }

  @Post('checkpoints/:checkpointId/tags')
  @Permissions('checkpoints:manage')
  registerTag(
    @Param() params: CheckpointParam,
    @Body() input: RegisterTagDto,
    @Req() request: Autenticado,
  ) {
    return this.puntos.registerTag(params.checkpointId, request.user.sub, input);
  }

  @Delete('tags/:tagId')
  @Permissions('checkpoints:manage')
  retireTag(@Param() params: TagParam, @Req() request: Autenticado) {
    return this.puntos.retireTag(params.tagId, request.user.sub);
  }
}
