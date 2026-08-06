import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { AVISO_INICIO_QUEUE_NAME } from './aviso-inicio-ronda.constants';
import { AvisoInicioRondaProcessor } from './aviso-inicio-ronda.processor';
import { AvisoInicioRondaService } from './aviso-inicio-ronda.service';
import { PushModule } from './push.module';

/**
 * Aviso al guardia de que su ronda esta por comenzar (#43).
 *
 * VA APARTE DE PushModule a proposito, con el mismo criterio que separa
 * EnvioInformeModule de ReportsModule: PushModule es el carril de REGISTRAR un
 * dispositivo y ENTREGAR un aviso (un puerto, un controlador, un worker de
 * entrega); esto es el carril de DECIDIR que hay algo que avisar. Separados,
 * apagar el recordatorio en un despliegue es sacar un modulo de AppModule, y no
 * comentar codigo dentro del que entrega los panicos.
 *
 * No tiene controlador: no hay nada que pedirle por HTTP. Se dispara solo, desde
 * su programador de BullMQ.
 *
 * DatabaseModule es obligatorio: el servicio inyecta TenantContextService y el
 * DataSource para abrir la transaccion de cada empresa. RulesModule aporta la
 * cascada de `patrolStartNoticeMin`. PushModule exporta PushService, que ya se
 * exportaba justamente para consumidores como este.
 *
 * La conexion raiz de BullMQ NO se registra aca: `BullModule.forRootAsync` de
 * MailModule se declara global y la comparte todo el proceso (mismo criterio que
 * PushModule y EnvioInformeModule). Declararla de nuevo abriria una segunda
 * conexion a Redis para nada.
 */
@Module({
  imports: [
    DatabaseModule,
    RulesModule,
    PushModule,
    BullModule.registerQueue({ name: AVISO_INICIO_QUEUE_NAME }),
  ],
  providers: [AvisoInicioRondaService, AvisoInicioRondaProcessor],
  // Se exporta para que un futuro endpoint de operacion —o una prueba de humo
  // contra staging— pueda forzar una pasada sin esperar al programador.
  exports: [AvisoInicioRondaService],
})
export class AvisoInicioRondaModule {}
