import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { GuardController } from './guard.controller';
import { GuardService } from './guard.service';

@Module({
  imports: [DatabaseModule],
  controllers: [GuardController],
  providers: [GuardService],
})
export class GuardModule {}
