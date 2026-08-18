import { Module } from '@nestjs/common';

import { AuditWriterModule } from '../audit/audit-writer.module';
import { DatabaseModule } from '../database/database.module';
import { AuthModule } from '../auth/auth.module';
import { EvidenceModule } from '../evidence/evidence.module';
import { RulesModule } from '../rules/rules.module';
import { SupervisorModule } from '../supervisor/supervisor.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { HorarioHabilController } from './horario-habil.controller';
import { HorarioHabilService } from './horario-habil.service';
import { PuntosSupervisorController } from './puntos-supervisor.controller';
import { PuntosSupervisorService } from './puntos-supervisor.service';

// EvidenceModule y RulesModule son para la comprobacion de horario habil (#68):
// el panel del admin pregunta por el MISMO isWithinBusinessHours() que corre en
// terreno, en vez de que la web reimplemente la regla de medianoche.
//
// AuditWriterModule entra por #309: dar de alta un punto o vincular una etiqueta
// NFC no dejaba ninguna linea en audit_log, y la auditoria es la contrapartida
// de que ahora tambien escriba el SUPERVISOR. Se auditan LOS DOS caminos desde
// AdminService; si solo se auditara el nuevo, el registro contaria una historia
// falsa donde el ADMIN nunca toco nada.
//
// SupervisorModule aporta `SupervisorService.ensureAssignedSite`, que es el
// control de "este recinto es tuyo". Se reusa en vez de copiarlo porque un
// control de acceso duplicado se arregla una vez y queda mal en el otro lado.
@Module({
  imports: [DatabaseModule, AuthModule, EvidenceModule, RulesModule, AuditWriterModule, SupervisorModule],
  controllers: [AdminController, HorarioHabilController, PuntosSupervisorController],
  providers: [AdminService, HorarioHabilService, PuntosSupervisorService],
})
export class AdminModule {}
