import { Controller, Get } from '@nestjs/common';

import { SkipTenantContext } from '../database/tenant-context/skip-tenant-context.decorator';

/**
 * `/health` responde si el proceso esta vivo. `/ready` responde si puede
 * atender trafico (base de datos y Redis alcanzables). Docker y Dokploy usan
 * `/ready` para no enrutar hacia un contenedor que todavia no sirve.
 *
 * Ver issue #6, sub-issue de observabilidad.
 */
@Controller()
@SkipTenantContext()
export class HealthController {
  @Get('health')
  health() {
    return { status: 'ok', service: 'voxia-api', ts: new Date().toISOString() };
  }

  @Get('ready')
  ready() {
    // TODO(#6): comprobar de verdad PostgreSQL y Redis antes de responder ok.
    return { status: 'ok', checks: { postgres: 'pending', redis: 'pending' } };
  }
}
