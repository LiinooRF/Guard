import { Transform } from 'class-transformer';
import { IsBooleanString, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Tipos de alerta de ronda (#98). Espejo del CHECK de patrol_alerts: si aca
 * entra uno nuevo, la migracion tiene que admitirlo o el INSERT falla en
 * produccion con el test en verde.
 *
 *   no_iniciada          — sigue 'pendiente' y ya paso la tolerancia de inicio.
 *                          Es la unica que NO espera al cierre de la ronda.
 *   atrasada             — arranco, la ventana cerro y sigue abierta.
 *   vencida              — paso la duracion maxima sin cerrarse.
 *   incompleta           — cerro bajo el umbral de cumplimiento del tenant.
 *   escaneos_sospechosos — junto suficientes escaneos con marca de anomalia.
 *   incidente_grave      — hubo una novedad de las criticidades que escalan.
 */
export const ALERT_KINDS = [
  'no_iniciada',
  'atrasada',
  'vencida',
  'incompleta',
  'escaneos_sospechosos',
  'incidente_grave',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** Urgencia de la bandeja, no criticidad del evento. Espejo del CHECK. */
export const ALERT_SEVERITIES = ['media', 'alta'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/**
 * Titulos que ve el jefe de operaciones, no el ingeniero. Se usan en el push y
 * en el tablero para que la misma alerta se lea igual en los dos lados.
 */
export const ALERT_TITULOS: Record<AlertKind, string> = {
  no_iniciada: 'Ronda sin iniciar',
  atrasada: 'Ronda atrasada',
  vencida: 'Ronda vencida',
  incompleta: 'Ronda bajo el umbral',
  escaneos_sospechosos: 'Escaneos con anomalías',
  incidente_grave: 'Incidente grave',
};

export class AttendAlertDto {
  /**
   * El comentario es OBLIGATORIO a proposito. "Quien atendio la alerta" sin
   * "que hizo" no sirve en la conversacion del dia siguiente ni en un informe:
   * un campo opcional en este formulario termina siempre vacio.
   *
   * Se recorta antes de validar porque patrol_alerts exige
   * length(trim(attended_comment)) BETWEEN 3 AND 500, y un comentario de puros
   * espacios reventaria contra ese CHECK y no contra el DTO.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  comment!: string;
}

export class ListAlertsQueryDto {
  /**
   * Llega por query string, asi que es texto: 'true' | 'false'. Por defecto el
   * tablero muestra SOLO lo pendiente — es una bandeja de trabajo, no un
   * historico, y arrancar con todo mezclado esconde lo que falta atender.
   */
  @IsOptional()
  @IsBooleanString()
  onlyPending?: string;
}
