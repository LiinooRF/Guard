import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:isPublic';

/** Excepción explícita al guard global deny-by-default. */
export const Public = () => SetMetadata(IS_PUBLIC, true);
