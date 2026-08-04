import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { PlantillasCorreoController } from './plantillas-correo.controller';
import { PlantillasContextoService } from './plantillas-contexto';
import { PlantillasCorreoService } from './plantillas-correo.service';
import { PlantillasMarcaService } from './plantillas-marca';
import { PlantillasRemitenteService } from './plantillas-remitente.service';

/**
 * Plantillas de correo y remitente por tenant (#42).
 *
 * VA APARTE DE MailModule A PROPOSITO. MailModule es el TRANSPORTE: proveedor
 * SMTP, cola y worker. Esto es el CONTENIDO y la marca, y necesita base de
 * datos y reglas, que el transporte no necesita para nada. Mezclarlos obligaria
 * al worker de correo a arrastrar una dependencia de Postgres solo para
 * arrancar.
 *
 * No importa MailModule: nada de aca encola. Los que encolan (AuthModule y
 * EnvioInformeModule) ya tienen MailQueueService y ahora ademas importan este
 * modulo para armar el contenido. Ver INTEGRACION.md.
 *
 * DatabaseModule por TenantContextService; RulesModule por RulesService, que
 * resuelve la cascada de `mailIncludeHtml` y `mailLogoMaxKB`.
 */
@Module({
  imports: [DatabaseModule, RulesModule],
  controllers: [PlantillasCorreoController],
  providers: [
    PlantillasMarcaService,
    PlantillasCorreoService,
    PlantillasRemitenteService,
    PlantillasContextoService,
  ],
  exports: [PlantillasMarcaService, PlantillasCorreoService, PlantillasContextoService],
})
export class PlantillasCorreoModule {}
