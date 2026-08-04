import { Module } from '@nestjs/common';

import { AlertsModule } from '../alerts/alerts.module';
import { DatabaseModule } from '../database/database.module';
import { EscalationModule } from '../escalation/escalation.module';
import { MailModule } from '../mail/mail.module';
import { RulesModule } from '../rules/rules.module';
import { GuardController } from './guard.controller';
import { GuardService } from './guard.service';

// Se exporta el servicio para que la sincronizacion en lote (#14) reuse
// registerScan/reportEvent en vez de reimplementar el flujo de escaneo.
@Module({
  imports: [DatabaseModule, MailModule, RulesModule, EscalationModule, AlertsModule],
  controllers: [GuardController],
  providers: [GuardService],
  exports: [GuardService],
})
export class GuardModule {}
