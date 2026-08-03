import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { SupervisorController } from './supervisor.controller';
import { SupervisorService } from './supervisor.service';

@Module({
  imports: [DatabaseModule, RulesModule],
  controllers: [SupervisorController],
  providers: [SupervisorService],
})
export class SupervisorModule {}
