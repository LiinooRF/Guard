import { Body, Controller, Get, HttpCode, Post, Query, Req, UseInterceptors } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { FeatureFlagsInterceptor, RequiresFeature } from '../rules/feature-flags.interceptor';
import { CrashReportingService } from './crash-reporting.service';
import { ReportCrashDto } from './dto/report-crash.dto';

class ResumenQuery {
  /**
   * Ventana en dias. Sin valor, se usa la retencion configurada del tenant, que
   * es el unico numero de negocio de esta pantalla y vive en la cascada de
   * reglas. El tope duro de 365 es de forma, no de negocio: evita que alguien
   * pida un rango absurdo por la URL.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number;
}

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * Reporte de caidas de la app del guardia (#27).
 *
 * POR QUE `account:sessions:manage` EN EL ALTA
 * Es el mismo criterio de PushController: reportar que MI app se cerro sola es
 * una accion sobre la propia cuenta y el propio dispositivo, no sobre los datos
 * de la empresa. Inventar un permiso nuevo para esto obligaria a tocar
 * `packages/shared`, que es contrato publicado de api, web y movil, para un
 * issue marcado opcional. Si el equipo prefiere un permiso propio
 * (`app:diagnostics:report`), en INTEGRACION.md esta el cambio exacto; el
 * codigo de aca solo cambia el decorador.
 *
 * SIN `@TenantScope()` EN EL ALTA, por la misma razon que PushController: ese
 * permiso lo tienen los cuatro roles, incluido SUPERADMIN, que por definicion
 * no tiene tenant, y marcarlo romperia la invariante de la matriz de
 * autorizacion. El endpoint igual corre dentro de la transaccion con RLS —el
 * TenantContextInterceptor es global— y una sesion sin tenant recibe 401 antes
 * de llegar al servicio. Un SUPERADMIN no usa la app del guardia.
 *
 * EL RESUMEN ES SOLO DEL ADMIN, Y NO DEL SUPERVISOR. El SUPERVISOR esta
 * limitado a sus recintos asignados (supervisor_sites), y una caida de la app
 * NO cuelga de un recinto: ocurre en un telefono. No hay forma de recortar esta
 * lista a "sus recintos", asi que dejarla abierta al supervisor le daria, de
 * hecho, una vista de toda la empresa. Mismo razonamiento que ConsentController
 * con el registro de consentimiento.
 *
 * TODO EL CONTROLADOR EXIGE EL MODULO `crashReporting`, que viene apagado de
 * fabrica (DEFAULT_FEATURE_FLAGS). Con el modulo apagado los dos endpoints
 * responden 404 y no se guarda ni se manda nada: es exactamente lo que promete
 * la ficha del modulo ("No se manda nada. Una falla hay que reportarla a mano")
 * y lo que significa que este issue sea opcional.
 */
@Controller('observability')
@UseInterceptors(FeatureFlagsInterceptor)
@RequiresFeature('crashReporting')
export class CrashReportsController {
  constructor(private readonly crash: CrashReportingService) {}

  /**
   * 202 y no 201: puede que el reporte no se guarde (telefono en bucle) y la
   * app no tiene nada que hacer al respecto. El cuerpo dice que paso, para
   * poder depurarlo desde el log de la app sin adivinar.
   */
  @Post('crash-reports')
  @Permissions('account:sessions:manage')
  @HttpCode(202)
  reportarFalla(@Body() input: ReportCrashDto, @Req() request: Autenticado) {
    return this.crash.registrarCaidaDeApp(request.user.sub, request.user.tenant_id, input);
  }

  /** Lo que ve el jefe de operaciones: que se cae, en que version y en que telefono. */
  @Get('crash-reports/summary')
  @Permissions('tenant:audit:read')
  @TenantScope()
  resumen(@Query() query: ResumenQuery) {
    return this.crash.resumen(query.days);
  }
}
