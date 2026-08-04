import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { ConsentController } from './consent.controller';
import { ConsentService } from './consent.service';

// DatabaseModule es obligatorio: ConsentService inyecta TenantContextService.
// RulesModule trae los parametros del aviso (cada cuanto se muestrea, cuanto se
// conserva, si una version nueva obliga a re-aceptar) y AuditModule registra la
// publicacion, que es una accion sensible.
//
// Se exporta ConsentService para que quien tenga que preguntar "¿esta persona
// acepto el texto VIGENTE?" no reimplemente la comparacion de versiones.
@Module({
  imports: [DatabaseModule, RulesModule, AuditModule],
  controllers: [ConsentController],
  providers: [ConsentService],
  exports: [ConsentService],
})
export class ConsentModule {}
