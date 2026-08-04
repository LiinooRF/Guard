import { IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';

const MENSAJE_FECHA = 'debe ser un dia calendario con formato YYYY-MM-DD';

/**
 * Filtros de la exportacion a Excel (#136).
 *
 * `from`/`to` son DIAS DEL RECINTO, no instantes, igual que en las graficas: la
 * conversion a zona horaria ocurre en el SQL contra `sites.timezone`. Si el
 * navegador mandara un instante, el corte del dia terminaria dependiendo de
 * donde este sentado quien descarga la planilla.
 *
 * `tenantId` no existe aqui a proposito y no debe agregarse: el tenant lo pone
 * el interceptor con `set_config('app.tenant_id', ..., true)` y lo aplica RLS.
 * Un tenant que viaja por query string es una IDOR con nombre nuevo.
 */
export class ExcelExportQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: `\`from\` ${MENSAJE_FECHA}` })
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: `\`to\` ${MENSAJE_FECHA}` })
  to?: string;

  @IsOptional()
  @IsUUID()
  siteId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  branchName?: string;

  /** Guardia cuya actividad se exporta. Sin valor, todos los del alcance. */
  @IsOptional()
  @IsUUID()
  guardId?: string;
}
