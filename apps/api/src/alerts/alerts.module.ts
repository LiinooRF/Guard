import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { PushModule } from '../push/push.module';
import { AlertsController } from './alerts.controller';
import { AlertsProcessor } from './alerts.processor';
import { ALERTS_QUEUE_NAME } from './alerts-queue.constants';
import { AlertsService } from './alerts.service';

@Module({
  imports: [DatabaseModule, PushModule, BullModule.registerQueue({ name: ALERTS_QUEUE_NAME })],
  controllers: [AlertsController],
  providers: [AlertsService, AlertsProcessor],
  exports: [AlertsService],
})
export class AlertsModule {}
