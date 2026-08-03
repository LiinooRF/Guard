import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { RulesModule } from '../rules/rules.module';
import { GeoController } from './geo.controller';
import { GeoService } from './geo.service';

// DatabaseModule es obligatorio: GeoService inyecta TenantContextService.
@Module({
  imports: [DatabaseModule, RulesModule],
  controllers: [GeoController],
  providers: [GeoService],
})
export class GeoModule {}
