import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { GuardModule } from '../guard/guard.module';
import { RulesModule } from '../rules/rules.module';
import { SyncController } from './sync.controller';
import { SyncService } from './sync.service';

// DatabaseModule es obligatorio: SyncService inyecta TenantContextService.
// GuardModule aporta GuardService — el lote REUSA registerScan/reportEvent en
// vez de reimplementar el flujo de escaneo. RulesModule trae el limite de lote,
// que es configuracion de la empresa y no un numero de este modulo.
@Module({
  imports: [DatabaseModule, GuardModule, RulesModule],
  controllers: [SyncController],
  providers: [SyncService],
})
export class SyncModule {}
