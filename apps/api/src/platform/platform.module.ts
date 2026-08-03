import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { MailModule } from '../mail/mail.module';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';

@Module({
  imports: [DatabaseModule, MailModule],
  controllers: [PlatformController],
  providers: [PlatformService],
})
export class PlatformModule {}
