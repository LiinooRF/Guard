import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Estado del permiso de ubicacion del sistema operativo. Lo reporta la app: el
 * servidor no tiene forma de averiguarlo.
 *
 * Espejo exacto del CHECK de gps_permission_reports.status en la migracion
 * 1725462010000. Si aca entra un valor nuevo, la migracion tiene que aceptarlo.
 */
export const GPS_PERMISSION_STATES = [
  'concedido',
  'solo_primer_plano',
  'denegado',
  'no_disponible',
] as const;

export type GpsPermissionState = (typeof GPS_PERMISSION_STATES)[number];

/** 'sin_reporte' no lo manda nadie: es lo que ve el servidor cuando no hay fila. */
export type GpsPermissionStateOrMissing = GpsPermissionState | 'sin_reporte';

/**
 * Estados con los que el telefono efectivamente entrega ubicacion.
 *
 * `solo_primer_plano` cuenta: en Android 10+ el permiso de segundo plano es un
 * tramite aparte que la Play Store revisa, y una ronda con la app abierta si
 * genera traza. Exigir segundo plano para dejar trabajar seria dejar en tierra a
 * media flota por un permiso que ni siquiera es el que se usa mientras el
 * guardia camina con el telefono en la mano.
 */
export const ESTADOS_QUE_COMPARTEN: readonly GpsPermissionStateOrMissing[] = [
  'concedido',
  'solo_primer_plano',
];

export class ReportGpsPermissionDto {
  @IsIn(GPS_PERMISSION_STATES, {
    message: 'status debe ser concedido, solo_primer_plano, denegado o no_disponible',
  })
  status!: GpsPermissionState;

  /** Marca y modelo. Nunca IMEI ni numero de telefono. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  deviceInfo?: string;
}
