import {
  Controller,
  ForbiddenException,
  Param,
  Req,
  Sse,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import { IsUUID } from 'class-validator';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { SkipTenantContext } from '../database/tenant-context/skip-tenant-context.decorator';
import { AssignedSiteGuard } from './assigned-site.guard';
import { EventsStreamService } from './events-stream.service';

class SiteParam {
  @IsUUID()
  siteId!: string;
}

type Autenticado = Request & { user: AuthenticatedUser };

@Controller('supervisor')
@TenantScope()
export class EventsStreamController {
  constructor(private readonly bandeja: EventsStreamService) {}

  /**
   * @SkipTenantContext() NO es un relajo del aislamiento: es obligatorio aca.
   *
   * TenantContextInterceptor envuelve cada request en una transaccion y la
   * cierra con `lastValueFrom(next.handle())`, o sea cuando el flujo COMPLETA.
   * Un flujo SSE no completa nunca mientras el supervisor mire la bandeja: la
   * transaccion —y su conexion del pool— quedarian tomadas por cada pestaña
   * abierta, y ademas el flujo terminaria suscrito dos veces (una por el
   * interceptor, otra por el emisor de Nest) sin que llegara un solo mensaje al
   * cliente.
   *
   * El contexto de tenant que sigue haciendo falta —verificar que el recinto es
   * del supervisor— lo abre AssignedSiteGuard en su propia transaccion corta,
   * que se cierra antes de que empiece el streaming.
   */
  @Sse('sites/:siteId/stream')
  @Permissions('patrols:monitor')
  @SkipTenantContext()
  @UseGuards(AssignedSiteGuard)
  stream(@Param() params: SiteParam, @Req() request: Autenticado): Observable<MessageEvent> {
    const tenantId = request.user.tenant_id;
    if (!tenantId) {
      throw new ForbiddenException('La operación requiere contexto de empresa');
    }
    return this.bandeja.streamForSite(tenantId, params.siteId);
  }
}
