import { Controller, Get, Query } from '@nestjs/common';

import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { ConfigAuditService } from './config-audit.service';
import { ConfigAuditParametersQuery, ConfigAuditQuery } from './dto/config-audit-query.dto';

/**
 * Historial de cambios de configuracion para el ADMIN de la empresa (#84).
 *
 * Cuelga de /admin/config-audit y no de /admin/audit para no cambiarle la forma
 * a la respuesta que ya consume el panel: `audit_log` sigue contando QUE paso
 * (usuarios, recintos, etiquetas) y este historial cuenta CUANTO valia el
 * parametro antes y cuanto vale ahora.
 *
 * Solo ADMIN, con `tenant:audit:read`, igual que el resto de la auditoria del
 * tenant. El SUPERVISOR queda fuera a proposito: la configuracion es de la
 * empresa completa y su alcance son los recintos que tiene asignados. Si algun
 * dia se le abriera, no alcanzaria con el rol — habria que filtrar por
 * supervisor_sites, y para el nivel 'tenant' esa pregunta no tiene respuesta.
 */
@Controller('admin/config-audit')
@TenantScope()
export class ConfigAuditController {
  constructor(private readonly configAudit: ConfigAuditService) {}

  /**
   * "Quien bajo el umbral al 40% el mes pasado" se responde con:
   * ?paramKey=complianceThreshold&newValue=40&direction=bajo
   *  &fromDay=2026-07-01&toDay=2026-07-31
   */
  @Get()
  @Permissions('tenant:audit:read')
  history(@Query() query: ConfigAuditQuery) {
    return this.configAudit.history(query);
  }

  /** Que parametros se han tocado, con su ultimo cambio. Pobla el filtro. */
  @Get('parameters')
  @Permissions('tenant:audit:read')
  parameters(@Query() query: ConfigAuditParametersQuery) {
    return this.configAudit.parameters(query.area);
  }
}
