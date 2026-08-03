import { Body, Controller, Get, Param, Patch, Post, Put, Req } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Request } from 'express';

import { UpdateActiveDto } from '../admin/dto/update-active.dto';
import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { ChecklistsService } from './checklists.service';
import {
  CreateChecklistTemplateDto,
  UpdateChecklistTemplateDto,
} from './dto/checklist-template.dto';
import { SubmitChecklistDto } from './dto/submit-responses.dto';

class TemplateParam {
  @IsUUID()
  templateId!: string;
}

class PatrolParam {
  @IsUUID()
  patrolId!: string;
}

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * El checklist es configuracion del tenant, asi que las plantillas van con
 * tenant:rules:manage (ADMIN) y la ejecucion con patrols:execute (GUARDIA).
 *
 * No hay borrado de plantillas: se desactivan. Sus items son la pregunta que
 * respondieron rondas ya cerradas.
 */
@Controller('checklists')
@TenantScope()
export class ChecklistsController {
  constructor(private readonly checklists: ChecklistsService) {}

  @Get('templates')
  @Permissions('tenant:rules:manage')
  listTemplates() {
    return this.checklists.listTemplates();
  }

  @Get('templates/:templateId')
  @Permissions('tenant:rules:manage')
  getTemplate(@Param() params: TemplateParam) {
    return this.checklists.getTemplate(params.templateId);
  }

  @Post('templates')
  @Permissions('tenant:rules:manage')
  createTemplate(@Body() input: CreateChecklistTemplateDto) {
    return this.checklists.createTemplate(input);
  }

  @Put('templates/:templateId')
  @Permissions('tenant:rules:manage')
  updateTemplate(@Param() params: TemplateParam, @Body() input: UpdateChecklistTemplateDto) {
    return this.checklists.updateTemplate(params.templateId, input);
  }

  @Patch('templates/:templateId/active')
  @Permissions('tenant:rules:manage')
  setTemplateActive(@Param() params: TemplateParam, @Body() input: UpdateActiveDto) {
    return this.checklists.setTemplateActive(params.templateId, input.isActive);
  }

  /** La plantilla que le toca a ESTA ronda, ya resuelta por recinto y turno. */
  @Get('patrols/:patrolId/template')
  @Permissions('patrols:execute')
  templateForPatrol(@Param() params: PatrolParam, @Req() request: Autenticado) {
    return this.checklists.templateForPatrol(params.patrolId, request.user.sub);
  }

  @Post('patrols/:patrolId/responses')
  @Permissions('patrols:execute')
  submitResponses(
    @Param() params: PatrolParam,
    @Body() input: SubmitChecklistDto,
    @Req() request: Autenticado,
  ) {
    return this.checklists.saveResponses(params.patrolId, request.user.sub, input);
  }
}
