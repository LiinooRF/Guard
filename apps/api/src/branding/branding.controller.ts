import { Body, Controller, Get, Put } from '@nestjs/common';
import { tenantBrandingSchema } from '@sentrycore/shared';

import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { BrandingService } from './branding.service';

@Controller('branding')
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  /**
   * Lo pide la web EN EL SERVIDOR antes del primer render. Basta con estar
   * dentro del tenant: todos los roles ven la marca de su empresa.
   */
  @Get()
  @Permissions('account:sessions:manage')
  theme() {
    return this.branding.theme();
  }

  @Put()
  @Permissions('tenant:rules:manage')
  @TenantScope()
  replace(@Body() input: unknown) {
    // Validado contra el schema compartido, igual que las reglas: el DTO ES el
    // contrato, y un campo desconocido es un 400 y no un dato que se pierde.
    const parsed = tenantBrandingSchema.partial().strict().parse(input ?? {});
    return this.branding.replace(parsed);
  }
}
