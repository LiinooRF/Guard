import { Controller, Get, Query } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { PurgaRetencionService } from './purga-retencion.service';

class ResumenQuery {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/**
 * Lo que el ADMIN de una empresa puede ver de la purga (#219).
 *
 * POR QUE ES DE SOLO LECTURA
 * --------------------------
 * No hay endpoint para "purgar ahora". Un borrado irreversible disparado a mano
 * desde el panel es exactamente la clase de boton que termina apretado por error
 * en la empresa equivocada, y no agrega nada: el plazo lo define la regla y el
 * barrido pasa cada seis horas. Cambiar el plazo ya se hace en la configuracion
 * de reglas, que ademas queda auditada.
 *
 * POR QUE `tenant:audit:read` Y NO UN PERMISO NUEVO
 * -------------------------------------------------
 * Esto ES auditoria: responde "que se borro de mis datos, cuando y con que
 * ventana". Lo lee el mismo rol que lee el resto del rastro. Un permiso nuevo
 * habria que sumarlo al catalogo compartido y a la tabla de permisos de la base,
 * y no habilita nada que `tenant:audit:read` no cubra ya.
 */
@Controller('admin')
@TenantScope()
export class PurgaRetencionController {
  constructor(private readonly purga: PurgaRetencionService) {}

  @Get('retencion')
  @Permissions('tenant:audit:read')
  resumen(@Query() query: ResumenQuery) {
    return this.purga.resumenDelTenant(query.limit);
  }
}
