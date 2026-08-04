import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { SupervisorModule } from '../supervisor/supervisor.module';
import { MapaRecorridoService } from './mapa-recorrido.service';

/**
 * Mapa del recorrido para el informe de ronda (#79).
 *
 * DatabaseModule: el servicio inyecta TenantContextService (la transaccion con
 * `app.tenant_id` puesto).
 * RulesModule: si el mapa entra al informe, el error GPS maximo y el tope de
 * posiciones dibujadas son configurables por tenant y por recinto.
 * SupervisorModule: `ensureAssignedSite` es el control de acceso a recintos del
 * SUPERVISOR y se reusa, no se reimplementa.
 *
 * Es un modulo propio y no un provider suelto de ReportsModule para que
 * ReportsModule no tenga que importar SupervisorModule por una dependencia que
 * no es suya.
 */
@Module({
  imports: [DatabaseModule, RulesModule, SupervisorModule],
  providers: [MapaRecorridoService],
  exports: [MapaRecorridoService],
})
export class MapaRecorridoModule {}
