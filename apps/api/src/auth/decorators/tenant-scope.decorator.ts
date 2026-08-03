import { SetMetadata } from '@nestjs/common';

export const REQUIRES_TENANT = 'auth:requiresTenant';

/** Exige que el JWT tenga tenant antes de abrir la transacción RLS. */
export const TenantScope = () => SetMetadata(REQUIRES_TENANT, true);
