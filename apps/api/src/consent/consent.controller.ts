import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { ConsentService } from './consent.service';
import { OffShiftAuditQuery } from './dto/off-shift-audit.dto';
import { PublishPolicyDto } from './dto/publish-policy.dto';

class PolicyParam {
  @IsUUID()
  policyId!: string;
}

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * Consentimiento del trabajador y cumplimiento legal del rastreo (#78).
 *
 * @TenantScope() va POR METODO y no en la clase, por el mismo motivo que en
 * GeoController: `GET /consent/policy` se pide con `account:sessions:manage`,
 * que tienen los cuatro roles — incluido SUPERADMIN, que por definicion no tiene
 * tenant. Marcarlo tenant-scoped romperia la invariante "SUPERADMIN fuera del
 * contexto tenant" de la matriz de autorizacion. Igual corre dentro de la
 * transaccion RLS: el TenantContextInterceptor es global.
 *
 * Los cuatro endpoints de administracion SI son tenant-scoped y solo ADMIN: el
 * registro de consentimiento y el informe de cumplimiento son de la empresa
 * completa. Deliberadamente NO se abren al SUPERVISOR: su alcance son sus
 * recintos asignados, y una lista de personas de toda la empresa no cabe en ese
 * alcance (habria que filtrarla por recinto, y el consentimiento no cuelga de un
 * recinto sino de la persona).
 */
@Controller('consent')
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  /**
   * El aviso vigente y el estado de QUIEN pregunta. Es lo que pinta la pantalla
   * de consentimiento del primer ingreso; el texto nunca se escribe en el
   * cliente.
   */
  @Get('policy')
  @Permissions('account:sessions:manage')
  currentPolicy(@Req() request: Autenticado) {
    return this.consent.currentPolicy(request.user.sub);
  }

  @Get('policies')
  @Permissions('tenant:rules:manage')
  @TenantScope()
  policyHistory() {
    return this.consent.policyHistory();
  }

  @Post('policies')
  @Permissions('tenant:rules:manage')
  @TenantScope()
  publishPolicy(@Body() input: PublishPolicyDto, @Req() request: Autenticado) {
    return this.consent.publishPolicy(request.user, input);
  }

  /** El texto completo de una version, incluso retirada: es la prueba. */
  @Get('policies/:policyId')
  @Permissions('tenant:rules:manage')
  @TenantScope()
  policyDetail(@Param() params: PolicyParam) {
    return this.consent.policyDetail(params.policyId);
  }

  /** Quien acepto, cuando y que version — y sobre todo, quien falta. */
  @Get('roster')
  @Permissions('tenant:audit:read')
  @TenantScope()
  roster() {
    return this.consent.roster();
  }

  /** La demostracion de que no se registro ubicacion fuera del turno. */
  @Get('off-shift-audit')
  @Permissions('tenant:audit:read')
  @TenantScope()
  offShiftAudit(@Query() query: OffShiftAuditQuery) {
    return this.consent.offShiftAudit(query);
  }
}
