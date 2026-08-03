import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { TenantDataController } from './tenant-data.controller';
import { TenantDataService } from './tenant-data.service';

@Module({
  imports: [DatabaseModule],
  controllers: [TenantDataController],
  providers: [TenantDataService],
})
export class TenantDataModule {}
