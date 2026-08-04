import { Body, Controller, Get, Param, Put, Query } from '@nestjs/common';
import {
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_PATROL_RULES,
  PATROL_RULE_LIST,
  ROLE_PLATFORMS,
  ROLES,
  RULE_GROUP_LABELS,
  RULE_GROUPS,
  RULE_SCOPES,
  RULE_UNIT_LABELS,
  RULE_VALUE_TYPES,
} from '@voxia/shared';

import { Permissions } from '../auth/decorators/permissions.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { SkipTenantContext } from '../database/tenant-context/skip-tenant-context.decorator';
import { CheckpointIdParam, EffectiveRulesQuery, SiteIdParam } from './dto/rule-context.dto';
import { UpdateRulesPipe, type UpdateRulesDto } from './dto/update-rules.dto';
import { RulesService } from './rules.service';

/**
 * Sin decoradores a nivel de clase, a proposito: `defaults` y `catalog` son
 * publicos y sin contexto tenant, pero el resto exige permiso y tenant. Un
 * @Public() de clase abriria tambien los endpoints de administracion (el guard
 * resuelve metodo primero, clase despues).
 */
@Controller('rules')
export class RulesController {
  constructor(private readonly rules: RulesService) {}

  @Get('defaults')
  @Public()
  @SkipTenantContext()
  defaults() {
    return {
      roles: ROLES,
      platforms: ROLE_PLATFORMS,
      patrolRules: DEFAULT_PATROL_RULES,
      featureFlags: DEFAULT_FEATURE_FLAGS,
      scopes: RULE_SCOPES,
      _nota:
        'Valores por defecto del producto. Un tenant nuevo opera con esto sin configurar nada. ' +
        'La configuracion efectiva de un contexto concreto se pide en GET /api/rules/effective.',
    };
  }

  /**
   * Catalogo de parametros de ronda (#81): tipo, rango, unidad, default,
   * descripcion en lenguaje del cliente y en que niveles se puede configurar.
   *
   * Publico como los defaults, y por la misma razon: es metadato del producto,
   * no configuracion de ninguna empresa. Es lo que deja que el panel del admin
   * (#83) pinte el formulario sin una sola lista de campos en la web.
   */
  @Get('catalog')
  @Public()
  @SkipTenantContext()
  catalog() {
    return {
      parameters: PATROL_RULE_LIST,
      scopes: RULE_SCOPES,
      valueTypes: RULE_VALUE_TYPES,
      groups: RULE_GROUPS,
      groupLabels: RULE_GROUP_LABELS,
      unitLabels: RULE_UNIT_LABELS,
    };
  }

  /**
   * EL endpoint unico de configuracion efectiva (#80). Devuelve las reglas ya
   * resueltas para el contexto pedido y de que nivel salio cada valor, para que
   * la app no reimplemente la cascada.
   *
   * Basta con estar dentro del tenant, como la marca: el guardia necesita saber
   * si su punto exige foto tanto como el admin que lo configura. Sin
   * @TenantScope el interceptor igual abre la transaccion con contexto — y sin
   * sesion con tenant, responde 401.
   */
  @Get('effective')
  @Permissions('account:sessions:manage')
  effective(@Query() query: EffectiveRulesQuery) {
    return this.rules.effectiveWithSource({
      siteId: query.siteId ?? null,
      checkpointId: query.checkpointId ?? null,
    });
  }

  @Get('admin')
  @Permissions('tenant:rules:manage')
  @TenantScope()
  tenantRules() {
    return this.rules.adminView();
  }

  /** El body reemplaza el set completo de overrides; omitir un campo lo vuelve al valor heredado. */
  @Put('admin')
  @Permissions('tenant:rules:manage')
  @TenantScope()
  updateTenantRules(@Body(new UpdateRulesPipe('tenant')) input: UpdateRulesDto) {
    return this.rules.updateOverrides(input);
  }

  @Get('admin/sites/:siteId')
  @Permissions('tenant:rules:manage')
  @TenantScope()
  siteRules(@Param() params: SiteIdParam) {
    return this.rules.siteView(params.siteId);
  }

  /** Configurar un recinto no afecta a los demas del mismo tenant. */
  @Put('admin/sites/:siteId')
  @Permissions('tenant:rules:manage')
  @TenantScope()
  updateSiteRules(
    @Param() params: SiteIdParam,
    @Body(new UpdateRulesPipe('site')) input: UpdateRulesDto,
  ) {
    return this.rules.updateSiteOverrides(params.siteId, input);
  }

  @Get('admin/checkpoints/:checkpointId')
  @Permissions('tenant:rules:manage')
  @TenantScope()
  checkpointRules(@Param() params: CheckpointIdParam) {
    return this.rules.checkpointView(params.checkpointId);
  }

  @Put('admin/checkpoints/:checkpointId')
  @Permissions('tenant:rules:manage')
  @TenantScope()
  updateCheckpointRules(
    @Param() params: CheckpointIdParam,
    @Body(new UpdateRulesPipe('checkpoint')) input: UpdateRulesDto,
  ) {
    return this.rules.updateCheckpointOverrides(params.checkpointId, input);
  }
}
