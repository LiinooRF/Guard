import { SetMetadata } from '@nestjs/common';
import type { Role } from '@voxia/shared';

export const REQUIRED_ROLES = 'auth:requiredRoles';

/** Un endpoint autenticado debe declarar al menos un rol permitido. */
export const Roles = (...roles: Role[]) => SetMetadata(REQUIRED_ROLES, roles);
