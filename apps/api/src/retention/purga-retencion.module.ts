import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { PURGA_RETENCION_QUEUE_NAME } from './purga-retencion.constantes';
import { PurgaRetencionController } from './purga-retencion.controller';
import { PurgaRetencionProcessor } from './purga-retencion.processor';
import { PurgaRetencionService } from './purga-retencion.service';

/**
 * Purga por retencion de datos (#219).
 *
 * DatabaseModule es obligatorio: el servicio inyecta TenantContextService (para
 * leer las reglas de cada empresa con su contexto) y el DataSource (para las
 * funciones cruza-tenants). RulesModule aporta RulesService, que ya se exporta.
 *
 * La conexion raiz de BullMQ NO se registra aca: `BullModule.forRootAsync` de
 * MailModule la comparte con todo el proceso, mismo criterio que EnvioInforme y
 * que Push. Declararla de nuevo abriria una segunda conexion a Redis para nada.
 *
 * Nada se exporta: la purga no es un servicio que otro modulo deba llamar. Se
 * dispara sola por su programador, y lo unico que sale hacia afuera es el
 * resumen de solo lectura del controlador.
 */
@Module({
  imports: [
    DatabaseModule,
    RulesModule,
    BullModule.registerQueue({ name: PURGA_RETENCION_QUEUE_NAME }),
  ],
  controllers: [PurgaRetencionController],
  providers: [PurgaRetencionService, PurgaRetencionProcessor],
})
export class PurgaRetencionModule {}
