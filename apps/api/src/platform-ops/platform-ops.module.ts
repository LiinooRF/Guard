import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { MailModule } from '../mail/mail.module';
import { PlatformMetricsService } from './platform-metrics.service';
import { PlatformOpsController } from './platform-ops.controller';
import { ProvisioningService } from './provisioning.service';

/**
 * DatabaseModule aunque ningun servicio de aca inyecte TenantContextService:
 * es el modulo que registra el DataSource (TypeOrmModule.forRootAsync) que
 * ambos servicios usan directo, igual que PlatformModule.
 * AuthModule aporta MailService (plantilla de invitacion) y MailModule la cola.
 */
@Module({
  imports: [DatabaseModule, AuthModule, MailModule],
  controllers: [PlatformOpsController],
  providers: [ProvisioningService, PlatformMetricsService],
})
export class PlatformOpsModule {}
