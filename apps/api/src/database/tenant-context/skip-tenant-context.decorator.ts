import { SetMetadata } from '@nestjs/common';

export const SKIP_TENANT_CONTEXT = 'skipTenantContext';

/**
 * Solo para endpoints que no consultan datos de negocio (salud, readiness).
 * Cualquier endpoint nuevo queda protegido por defecto.
 */
export const SkipTenantContext = () => SetMetadata(SKIP_TENANT_CONTEXT, true);
