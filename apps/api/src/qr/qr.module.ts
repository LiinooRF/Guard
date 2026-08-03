import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { QrController } from './qr.controller';
import { QrService } from './qr.service';

// DatabaseModule es obligatorio: QrService inyecta TenantContextService.
// RulesModule trae allowQrFallback y AuditModule el registro de la emision.
// Se exporta QrService para que el alta de un punto pueda emitir su etiqueta
// sin reimplementar la generacion del UID.
@Module({
  imports: [DatabaseModule, RulesModule, AuditModule],
  controllers: [QrController],
  providers: [QrService],
  exports: [QrService],
})
export class QrModule {}
