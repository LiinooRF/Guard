import { Controller, Get, Query } from '@nestjs/common';
import { IsISO8601, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { AuditService } from './audit.service';
import { StatsService } from './stats.service';

class AuditQuery {
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @IsString()
  action?: string;

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

class StatsQuery {
  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsString()
  branchName?: string;
}

@Controller('admin')
@TenantScope()
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly stats: StatsService,
  ) {}

  @Get('audit')
  @Permissions('tenant:audit:read')
  listAudit(@Query() query: AuditQuery) {
    return this.audit.list(query);
  }

  @Get('audit/actions')
  @Permissions('tenant:audit:read')
  auditActions() {
    return this.audit.availableActions();
  }

  @Get('stats/overview')
  @Permissions('tenant:stats:read')
  statsOverview(@Query() query: StatsQuery) {
    return this.stats.overview(query);
  }

  @Get('stats/trend')
  @Permissions('tenant:stats:read')
  statsTrend(@Query() query: StatsQuery) {
    return this.stats.trend(query, query.branchName);
  }
}
