import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { GuardModule } from '../guard/guard.module';
import { RulesModule } from '../rules/rules.module';
import { SupervisorModule } from '../supervisor/supervisor.module';
import { SyncConflictsService } from './sync-conflicts.service';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

// DatabaseModule es obligatorio: SyncService inyecta TenantContextService.
// GuardModule aporta GuardService — el lote REUSA registerScan/reportEvent en
// vez de reimplementar el flujo de escaneo. RulesModule trae el limite de lote,
// la tolerancia de reloj y el plazo de las marcas atrasadas, que son
// configuracion de la empresa y no numeros de este modulo.
//
// SupervisorModule entra por una sola cosa y por una razon de seguridad:
// ensureAssignedSite. El SUPERVISOR esta limitado a SUS recintos, y duplicar
// ese control aca seria duplicar un control de acceso — la clase de codigo que
// se arregla en un lado y se olvida en el otro. SupervisorModule ya exporta
// SupervisorService (lo consume tambien SchedulingModule).
@Module({
  imports: [DatabaseModule, GuardModule, RulesModule, SupervisorModule],
  controllers: [SyncController],
  providers: [SyncService, SyncConflictsService],
})
export class SyncModule {}
