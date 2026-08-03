import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { MailModule } from '../mail/mail.module';
import { RulesModule } from '../rules/rules.module';
import { EscalationController } from './escalation.controller';
import { EscalationService } from './escalation.service';

// DatabaseModule es obligatorio: EscalationService inyecta TenantContextService.
// Se exporta el servicio porque GuardService delega en el al reportar un evento.
@Module({
  imports: [DatabaseModule, MailModule, RulesModule],
  controllers: [EscalationController],
  providers: [EscalationService],
  exports: [EscalationService],
})
export class EscalationModule {}
