import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { DatabaseModule } from '../database/database.module';
import { MailModule } from '../mail/mail.module';
import { RulesModule } from '../rules/rules.module';
import { ENVIO_INFORME_QUEUE_NAME } from './envio-informe.constants';
import { EnvioInformeController } from './envio-informe.controller';
import { EnvioInformeProcessor } from './envio-informe.processor';
import { EnvioInformeService } from './envio-informe.service';
import { ReportsModule } from './reports.module';

/**
 * Envio automatico del informe al cierre de la ronda (#86).
 *
 * Va aparte de ReportsModule a proposito: ReportsModule es el carril de PEDIR un
 * informe (un request, una respuesta) y este es el de MANDARLO solo (una cola y
 * un worker). Separados, apagar el envio automatico en un despliegue es sacar un
 * modulo, y no comentar codigo dentro del que sirve las descargas.
 *
 * DatabaseModule es obligatorio: el servicio inyecta TenantContextService y el
 * worker inyecta el DataSource para abrir su propia transaccion.
 * ReportsModule aporta PatrolReportService, que ya se exporta justamente para
 * este consumidor. MailModule aporta la cola de correo.
 *
 * La conexion raiz de BullMQ NO se registra aca: `BullModule.forRootAsync` de
 * MailModule la comparte con todo el proceso (mismo criterio que PushModule).
 * Declararla de nuevo abriria una segunda conexion a Redis para nada.
 */
@Module({
  imports: [
    DatabaseModule,
    RulesModule,
    MailModule,
    ReportsModule,
    BullModule.registerQueue({ name: ENVIO_INFORME_QUEUE_NAME }),
  ],
  controllers: [EnvioInformeController],
  providers: [EnvioInformeService, EnvioInformeProcessor],
  // Se exporta porque quien dispara el envio es otro: GuardService llama a
  // alCerrarRonda() al marcarse el punto de cierre.
  exports: [EnvioInformeService],
})
export class EnvioInformeModule {}
