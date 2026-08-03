import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { MailModule } from '../mail/mail.module';
import { GuardController } from './guard.controller';
import { GuardService } from './guard.service';

@Module({
  imports: [DatabaseModule, MailModule],
  controllers: [GuardController],
  providers: [GuardService],
})
export class GuardModule {}
