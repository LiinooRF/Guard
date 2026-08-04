import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { ConfigAuditController } from './config-audit.controller';
import { ConfigAuditService } from './config-audit.service';
import { PlatformConfigAuditController } from './platform-config-audit.controller';
import { PlatformConfigAuditService } from './platform-config-audit.service';

/**
 * Historial de cambios de configuracion (#84).
 *
 * Modulo aparte de AuditModule y no dentro de el: AuditModule importa
 * RulesModule, y meter aca un servicio que manana necesite reglas efectivas
 * volveria a acercar el ciclo que AuditWriterModule fue creado para evitar.
 * Este modulo no depende de las reglas — solo lee el historial — asi que no
 * tiene por que arrastrar esa dependencia.
 *
 * No exporta nada: nadie mas escribe ni lee este historial desde el codigo. La
 * escritura la hace un trigger de PostgreSQL, no un servicio.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [ConfigAuditController, PlatformConfigAuditController],
  providers: [ConfigAuditService, PlatformConfigAuditService],
})
export class ConfigAuditModule {}
