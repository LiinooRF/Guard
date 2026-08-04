import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { EventsStreamModule } from '../events-stream/events-stream.module';
import { PushModule } from '../push/push.module';
import { RulesModule } from '../rules/rules.module';
import { SupervisorModule } from '../supervisor/supervisor.module';
import { AlertasRondaController } from './alertas-ronda.controller';
import { AlertasRondaService } from './alertas-ronda.service';

/**
 * Modulo propio y no un proveedor mas de EscalationModule: escalation avisa de
 * EVENTOS reportados por el guardia y esto avisa de RONDAS que se salieron de
 * lo programado. Comparten carpeta y criterio (avisar y pedir acuse), no
 * dependencias: aca entran PushModule y EventsStreamModule, y no entra
 * MailModule — el correo de una ronda vencida a las 03:00 no lo lee nadie
 * hasta la mañana, y para eso ya esta el informe.
 *
 * SupervisorModule es obligatorio: de ahi sale ensureAssignedSite(), que es el
 * control de acceso por recinto. Duplicarlo seria duplicar un control de acceso.
 *
 * Se exporta el servicio para que el worker repetible que algun dia dispare la
 * deteccion (ver INTEGRACION.md) pueda inyectarlo sin volver a cablear nada.
 */
@Module({
  imports: [DatabaseModule, RulesModule, SupervisorModule, PushModule, EventsStreamModule],
  controllers: [AlertasRondaController],
  providers: [AlertasRondaService],
  exports: [AlertasRondaService],
})
export class AlertasRondaModule {}
