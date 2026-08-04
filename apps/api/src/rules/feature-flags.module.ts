import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { FeatureFlagsPlatformController } from './feature-flags-platform.controller';
import { FeatureFlagsPlatformService } from './feature-flags-platform.service';
import { FeatureFlagsController } from './feature-flags.controller';
import { FeatureFlagsInterceptor } from './feature-flags.interceptor';
import { FeatureFlagsService } from './feature-flags.service';

/**
 * Feature flags de modulos por tenant y por plan (#82).
 *
 * Modulo propio y no dentro de RulesModule: las reglas configuran COMO opera la
 * empresa y los flags deciden QUE compro. Se tocan por motivos distintos y los
 * escriben roles distintos.
 *
 * DatabaseModule es obligatorio: FeatureFlagsService inyecta
 * TenantContextService y FeatureFlagsPlatformService el DataSource (el nivel
 * plataforma no tiene tenant).
 *
 * Se exportan el servicio y el interceptor para que cualquier modulo que venda
 * una funcion (informes, mapas, novedades) pueda preguntar por ella sin volver a
 * leer la base a mano.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [FeatureFlagsController, FeatureFlagsPlatformController],
  providers: [FeatureFlagsService, FeatureFlagsPlatformService, FeatureFlagsInterceptor],
  exports: [FeatureFlagsService, FeatureFlagsInterceptor],
})
export class FeatureFlagsModule {}
