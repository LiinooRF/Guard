import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { SupervisorController } from './supervisor.controller';
import { SupervisorService } from './supervisor.service';

@Module({
  imports: [DatabaseModule],
  controllers: [SupervisorController],
  providers: [SupervisorService],
})
export class SupervisorModule {}
