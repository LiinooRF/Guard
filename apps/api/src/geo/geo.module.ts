import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { SupervisorModule } from '../supervisor/supervisor.module';
import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';
import { GpsPolicyController } from './gps-policy.controller';
import { GpsPolicyService } from './gps-policy.service';

/**
 * DatabaseModule es obligatorio: los servicios inyectan TenantContextService.
 *
 * SupervisorModule entra por #77: GpsPolicyService reusa
 * `SupervisorService.ensureAssignedSite()` en vez de repetir la consulta a
 * supervisor_sites. Duplicar un control de acceso es como se terminan teniendo
 * dos, y uno desactualizado.
 *
 * GpsPolicyService se EXPORTA porque GuardService tiene que llamar a
 * `assertPatrolStartAllowed()` al iniciar la ronda (ver INTEGRACION.md).
 */
@Module({
  imports: [DatabaseModule, RulesModule, SupervisorModule],
  controllers: [GeoController, GpsPolicyController],
  providers: [GeoService, GpsPolicyService],
  exports: [GpsPolicyService],
})
export class GeoModule {}
