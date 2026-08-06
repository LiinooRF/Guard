import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { DatabaseModule } from '../database/database.module';
import { MailModule } from '../mail/mail.module';
import { RulesModule } from '../rules/rules.module';
import { BarridoEnvioService, ENVIO_BARRIDO_QUEUE_NAME } from './envio-informe.barrido';
import { BarridoEnvioProcessor } from './envio-informe.barrido.processor';
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
 *
 * DOS COLAS, NO UNA
 * -----------------
 * `report-dispatch` despacha el informe de UNA ronda, con contexto de tenant y
 * jobId idempotente por ronda. `report-dispatch-sweep` es el barrido periodico
 * que busca rondas cerradas que se quedaron sin informe; corre sin tenant, es
 * uno solo para toda la plataforma y sus jobs se descartan al completarse. Ver
 * envio-informe.barrido.processor.ts para por que no comparten cola.
 */
@Module({
  imports: [
    DatabaseModule,
    RulesModule,
    MailModule,
    ReportsModule,
    BullModule.registerQueue(
      { name: ENVIO_INFORME_QUEUE_NAME },
      { name: ENVIO_BARRIDO_QUEUE_NAME },
    ),
  ],
  controllers: [EnvioInformeController],
  // `DOMINIOS_NO_DESPACHABLES` ya NO se provee aca: lo provee y lo exporta
  // MailModule, que esta en `imports`. La lista se movio junto con la supresion
  // a `MailQueueService.enqueue`, que es el unico cuello por donde pasa todo el
  // correo del producto y no solo el informe.
  //
  // Declararla tambien aca compilaba y daba el mismo resultado —las dos
  // factories leian las mismas dos claves del mismo ConfigService—, pero son dos
  // listas resueltas por separado: el dia que una se toque y la otra no, el
  // informe y la cola discrepan sobre a quien se le escribe, y el sintoma es que
  // el despacho anota una fila en `report_deliveries` para una direccion que la
  // cola despues descarta. Una sola lista, la de la cola.
  providers: [
    EnvioInformeService,
    EnvioInformeProcessor,
    BarridoEnvioService,
    BarridoEnvioProcessor,
  ],
  // Se exporta porque quien dispara el envio es otro: GuardService llama a
  // alCerrarRonda() al marcarse el punto de cierre.
  exports: [EnvioInformeService],
})
export class EnvioInformeModule {}
