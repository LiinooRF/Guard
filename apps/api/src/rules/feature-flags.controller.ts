import { Body, Controller, Get, Put } from '@nestjs/common';
import { DEFAULT_FEATURE_FLAGS } from '@sentrycore/shared';

import { Permissions } from '../auth/decorators/permissions.decorator';
import { Public } from '../auth/decorators/public.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { SkipTenantContext } from '../database/tenant-context/skip-tenant-context.decorator';
import {
  FEATURE_LEVELS,
  FEATURE_LEVEL_LABELS,
  FEATURE_MODULE_LIST,
} from './feature-flags.catalog';
import { UpdateFeatureFlagsPipe, type UpdateFeatureFlagsDto } from './feature-flags.dto';
import { FeatureFlagsService } from './feature-flags.service';

/**
 * Modulos habilitados de la empresa de la sesion (#82).
 *
 * Sin decoradores a nivel de clase, a proposito, por lo mismo que
 * RulesController: `catalog` es publico y sin contexto tenant, y un @Public() de
 * clase abriria tambien la administracion (el guard resuelve metodo primero,
 * clase despues).
 */
@Controller('features')
export class FeatureFlagsController {
  constructor(private readonly features: FeatureFlagsService) {}

  /**
   * Catalogo de modulos: nombre, que hace y que deja de verse al apagarlo.
   *
   * Publico como /api/rules/catalog y por la misma razon: es metadato del
   * producto, no configuracion de ninguna empresa. Es lo que deja que el panel
   * pinte las casillas sin una lista de modulos escrita en la web.
   */
  @Get('catalog')
  @Public()
  @SkipTenantContext()
  catalog() {
    return {
      modules: FEATURE_MODULE_LIST,
      defaults: DEFAULT_FEATURE_FLAGS,
      levels: FEATURE_LEVELS,
      levelLabels: FEATURE_LEVEL_LABELS,
    };
  }

  /**
   * Los modulos prendidos de la empresa. Basta con estar dentro del tenant, como
   * la marca: el guardia necesita saber si tiene libro de novedades tanto como
   * el admin que lo contrata. Sin @TenantScope el interceptor igual abre la
   * transaccion con contexto — y sin sesion con tenant, responde 401.
   */
  @Get()
  @Permissions('account:sessions:manage')
  overview() {
    return this.features.overview();
  }

  /** Vista de administracion: el techo de la licencia y lo que se puede tocar. */
  @Get('admin')
  @Permissions('tenant:rules:manage')
  @TenantScope()
  adminView() {
    return this.features.adminView();
  }

  /**
   * El body reemplaza el set completo de preferencias; omitir un modulo lo
   * devuelve a su valor de fabrica. Prender uno que la licencia no incluye es
   * 403 y nombra el modulo.
   */
  @Put('admin')
  @Permissions('tenant:rules:manage')
  @TenantScope()
  updateAdminPreferences(@Body(new UpdateFeatureFlagsPipe()) input: UpdateFeatureFlagsDto) {
    return this.features.replacePreferences(input);
  }
}
