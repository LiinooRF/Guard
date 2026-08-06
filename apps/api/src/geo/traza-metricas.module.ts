import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { SupervisorModule } from '../supervisor/supervisor.module';
import { TrazaMetricasController } from './traza-metricas.controller';
import { TrazaMetricasService } from './traza-metricas.service';

/**
 * Traza del recorrido como dato de primera clase (#134).
 *
 * Modulo propio en vez de sumar el controlador a GeoModule: ese modulo es del
 * carril de #15/#77 y tiene trabajo en curso. Un modulo aparte se enchufa con
 * una linea en app.module.ts y se saca con una linea.
 *
 * - DatabaseModule: el servicio inyecta TenantContextService.
 * - RulesModule: los umbrales salen de la cascada de reglas del recinto.
 * - SupervisorModule: se reusa `ensureAssignedSite()` en vez de repetir la
 *   consulta a supervisor_sites. Duplicar un control de acceso es como se
 *   terminan teniendo dos, y uno desactualizado.
 *
 * TrazaMetricasService se EXPORTA porque el informe en PDF (#79) deberia leer de
 * aca su distancia en vez de calcular la suya (ver INTEGRACION.md).
 */
@Module({
  imports: [DatabaseModule, RulesModule, SupervisorModule],
  controllers: [TrazaMetricasController],
  providers: [TrazaMetricasService],
  exports: [TrazaMetricasService],
})
export class TrazaMetricasModule {}
