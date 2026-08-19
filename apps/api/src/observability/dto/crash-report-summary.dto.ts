/**
 * Contrato publico del agregado de caidas que puede llegar al navegador.
 *
 * No se agregan campos de investigacion a este DTO: huella, mensaje, pila,
 * fechas, ids y cualquier dato libre se quedan del lado servidor/proveedor.
 * Esta lista cerrada es una frontera de privacidad, no solo una conveniencia
 * para la vista.
 */
export interface CrashReportSummaryGroupDto {
  readonly errorName: string;
  readonly appVersion: string;
  readonly deviceModel: string;
  readonly androidVersion: string;
  readonly total: number;
  readonly fatales: number;
}

export interface CrashReportSummaryDto {
  readonly ventanaDias: number;
  readonly retencionDias: number;
  readonly grupos: readonly CrashReportSummaryGroupDto[];
}
