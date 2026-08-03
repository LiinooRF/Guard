import { SetMetadata } from '@nestjs/common';
import type { Permission } from '@voxia/shared';

export const REQUIRED_PERMISSIONS = 'auth:requiredPermissions';

/** Un endpoint autenticado declara capacidades; la matriz decide qué roles las poseen. */
export const Permissions = (...permissions: Permission[]) =>
  SetMetadata(REQUIRED_PERMISSIONS, permissions);
