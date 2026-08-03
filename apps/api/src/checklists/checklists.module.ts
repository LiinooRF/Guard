import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { EventsStreamModule } from '../events-stream/events-stream.module';
import { MailModule } from '../mail/mail.module';
import { RulesModule } from '../rules/rules.module';
import { ChecklistsController } from './checklists.controller';
import { ChecklistsService } from './checklists.service';

/**
 * DatabaseModule es obligatorio: ChecklistsService inyecta TenantContextService.
 * MailModule aporta la cola de correo del aviso de falla, RulesModule la regla
 * que decide si ese aviso se manda, y EventsStreamModule la bandeja en vivo.
 *
 * Se exporta el servicio para que el lote de sincronizacion offline (#14) pueda
 * delegar las respuestas sin pasar por HTTP, igual que hace con GuardService.
 */
@Module({
  imports: [DatabaseModule, MailModule, RulesModule, EventsStreamModule],
  controllers: [ChecklistsController],
  providers: [ChecklistsService],
  exports: [ChecklistsService],
})
export class ChecklistsModule {}
