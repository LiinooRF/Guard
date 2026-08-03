import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { AssignedSiteGuard } from './assigned-site.guard';
import { EventsStreamController } from './events-stream.controller';
import { EventsStreamService } from './events-stream.service';

/**
 * DatabaseModule aporta el DataSource con el que EventsStreamService abre su
 * transaccion corta de verificacion de alcance.
 *
 * Se exporta el servicio porque los publicadores viven fuera: GuardService al
 * registrar un evento en terreno y ChecklistsService al guardar una falla.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [EventsStreamController],
  providers: [EventsStreamService, AssignedSiteGuard],
  exports: [EventsStreamService],
})
export class EventsStreamModule {}
