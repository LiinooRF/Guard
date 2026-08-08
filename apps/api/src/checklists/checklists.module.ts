import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { EventsStreamModule } from '../events-stream/events-stream.module';
import { MailModule } from '../mail/mail.module';
import { RulesModule } from '../rules/rules.module';
import { SupervisorModule } from '../supervisor/supervisor.module';
import { ChecklistsController } from './checklists.controller';
import { ChecklistsService } from './checklists.service';
import { TareasTurnoController } from './tareas-turno.controller';
import { TareasTurnoService } from './tareas-turno.service';

/**
 * DatabaseModule es obligatorio: ChecklistsService inyecta TenantContextService.
 * MailModule aporta la cola de correo del aviso de falla, RulesModule la regla
 * que decide si ese aviso se manda, y EventsStreamModule la bandeja en vivo.
 *
 * Se exporta el servicio para que el lote de sincronizacion offline (#14) pueda
 * delegar las respuestas sin pasar por HTTP, igual que hace con GuardService.
 *
 * SupervisorModule entra por el editor de tareas del turno (#265): aporta
 * `SupervisorService.ensureAssignedSite`, que es el control de "este recinto es
 * tuyo". Se reusa en vez de copiarlo porque un control de acceso duplicado se
 * arregla una vez y queda mal en el otro lado.
 */
@Module({
  imports: [DatabaseModule, MailModule, RulesModule, EventsStreamModule, SupervisorModule],
  controllers: [ChecklistsController, TareasTurnoController],
  providers: [ChecklistsService, TareasTurnoService],
  exports: [ChecklistsService],
})
export class ChecklistsModule {}
