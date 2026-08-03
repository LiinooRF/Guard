import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { MailModule } from '../mail/mail.module';
import { RulesModule } from '../rules/rules.module';
import { GuardController } from './guard.controller';
import { GuardService } from './guard.service';

@Module({
  imports: [DatabaseModule, MailModule, RulesModule],
  controllers: [GuardController],
  providers: [GuardService],
})
export class GuardModule {}
