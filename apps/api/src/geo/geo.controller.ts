import { Body, Controller, Delete, Get, Param, Post, Query, Req } from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { AppendTrackDto } from './dto/append-track.dto';
import { GpsPolicyQuery } from './dto/gps-query.dto';
import { GrantConsentDto } from './dto/grant-consent.dto';
import { GeoService } from './geo.service';

class PatrolParam {
  @IsUUID()
  patrolId!: string;
}

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * @TenantScope() va por metodo y NO en la clase: los endpoints de
 * consentimiento se piden con `account:sessions:manage`, que tienen los 4 roles
 * — incluido SUPERADMIN, que por definicion no tiene tenant. Marcarlos como
 * tenant-scoped romperia la invariante de la matriz de autorizacion ("SUPERADMIN
 * fuera del contexto tenant"). Igual corren dentro de la transaccion RLS: el
 * TenantContextInterceptor es global y sin tenant en la sesion responde 401.
 */
@Controller('geo')
export class GeoController {
  constructor(private readonly geo: GeoService) {}

  @Post('patrols/:patrolId/track')
  @Permissions('patrols:execute')
  @TenantScope()
  appendTrack(
    @Param() params: PatrolParam,
    @Body() input: AppendTrackDto,
    @Req() request: Autenticado,
  ) {
    return this.geo.appendTrack(request.user.sub, params.patrolId, input.points);
  }

  @Get('patrols/:patrolId/track')
  @Permissions('patrols:monitor')
  @TenantScope()
  patrolTrack(@Param() params: PatrolParam, @Req() request: Autenticado) {
    return this.geo.patrolTrack(params.patrolId, request.user);
  }

  /** Cada usuario gestiona SU consentimiento; nadie lo acepta por otro. */
  @Post('consent')
  @Permissions('account:sessions:manage')
  grantConsent(@Body() input: GrantConsentDto, @Req() request: Autenticado) {
    return this.geo.grantConsent(request.user.sub, input);
  }

  @Delete('consent')
  @Permissions('account:sessions:manage')
  revokeConsent(@Req() request: Autenticado) {
    return this.geo.revokeConsent(request.user.sub);
  }

  /**
   * El recinto es opcional y se reusa GpsPolicyQuery a proposito: es el mismo
   * parametro con el mismo significado que en GET /api/geo/policy, y el
   * intervalo de muestreo que devuelven los dos tiene que salir de la misma
   * cascada. Sin recinto responde al nivel de la empresa, como antes.
   */
  @Get('consent')
  @Permissions('account:sessions:manage')
  consentStatus(@Query() query: GpsPolicyQuery, @Req() request: Autenticado) {
    return this.geo.consentStatus(request.user.sub, query.siteId ?? null);
  }
}
