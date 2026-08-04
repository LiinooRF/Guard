import {
  Injectable,
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';

import type { FeatureFlagKey } from './feature-flags.catalog';
import { FeatureFlagsService } from './feature-flags.service';

export const REQUIRED_FEATURE = 'features:requiredModule';

/**
 * Marca un endpoint como parte de un modulo vendible: si la empresa no lo tiene,
 * el endpoint responde 404 y desaparece, en vez de quedar visible y bloqueado.
 */
export const RequiresFeature = (feature: FeatureFlagKey) =>
  SetMetadata(REQUIRED_FEATURE, feature);

/**
 * INTERCEPTOR y no guard, y esto no es un detalle de gusto.
 *
 * Los guards de Nest corren ANTES de los interceptores, y el contexto de tenant
 * (la transaccion con `app.tenant_id` seteado) lo abre TenantContextInterceptor.
 * Un guard que preguntara por los modulos de la empresa reventaria con "no
 * existe una transaccion asociada al contexto tenant actual".
 *
 * Como se usa: a nivel de controlador con `@UseInterceptors(FeatureFlagsInterceptor)`
 * y despues `@RequiresFeature('map')` en el metodo o en la clase. A nivel de
 * controlador queda garantizado que corre DESPUES de los interceptores globales,
 * que es lo que hace falta. Registrarlo global obligaria a controlar el orden de
 * los APP_INTERCEPTOR entre modulos, que Nest no promete.
 *
 * Sin el decorador no opina: el que cierra por defecto es el guard de
 * autorizacion, no este.
 */
@Injectable()
export class FeatureFlagsInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly features: FeatureFlagsService,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const modulo = this.reflector.getAllAndOverride<FeatureFlagKey | undefined>(
      REQUIRED_FEATURE,
      [context.getHandler(), context.getClass()],
    );
    if (!modulo) return next.handle();

    // Lanza NotFoundException si el modulo esta apagado para esta empresa.
    await this.features.assertEnabled(modulo);
    return next.handle();
  }
}
