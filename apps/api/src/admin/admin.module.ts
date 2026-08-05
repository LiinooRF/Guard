import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { EvidenceModule } from '../evidence/evidence.module';
import { RulesModule } from '../rules/rules.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { HorarioHabilController } from './horario-habil.controller';
import { HorarioHabilService } from './horario-habil.service';

// EvidenceModule y RulesModule son para la comprobacion de horario habil (#68):
// el panel del admin pregunta por el MISMO isWithinBusinessHours() que corre en
// terreno, en vez de que la web reimplemente la regla de medianoche.
@Module({
  imports: [DatabaseModule, AuthModule, EvidenceModule, RulesModule],
  controllers: [AdminController, HorarioHabilController],
  providers: [AdminService, HorarioHabilService],
})
export class AdminModule {}
