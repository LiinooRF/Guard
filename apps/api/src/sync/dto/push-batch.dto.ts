import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsISO8601,
  IsObject,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export const SYNC_OPERATION_KINDS = ['scan', 'event'] as const;
export type SyncOperationKind = (typeof SYNC_OPERATION_KINDS)[number];

/**
 * Techo tecnico, solo anti-DoS: evita que el pipe global valide un arreglo sin
 * fin. El maximo REAL por empresa es la regla syncMaxBatchSize (rules.ts) y lo
 * aplica SyncService respondiendo 413; este valor coincide con el tope del
 * schema, asi que ningun tenant puede configurar un limite por encima.
 */
export const SYNC_BATCH_CEILING = 1000;

export class SyncOperationDto {
  @IsIn(SYNC_OPERATION_KINDS)
  type!: SyncOperationKind;

  /**
   * Clave de idempotencia de la operacion, generada por EL DISPOSITIVO al
   * encolar. Es la misma que viaja como clientScanId / clientEventId dentro del
   * payload: una sola clave para la bitacora y para la tabla de destino.
   */
  @IsUUID()
  clientId!: string;

  /** Obligatorio para 'scan'; en 'event' manda sobre el patrolId del payload. */
  @IsOptional()
  @IsUUID()
  patrolId?: string;

  /**
   * El mismo cuerpo que aceptan los endpoints online (CreateScanDto para
   * 'scan', ReportEventDto para 'event'). NO se valida aca a proposito: el pipe
   * global rechaza el request COMPLETO ante el primer error, y ese es justo el
   * escenario prohibido — 40 escaneos perdidos porque uno venia mal. La
   * validacion del payload ocurre operacion por operacion en SyncService.
   */
  @IsObject()
  payload!: Record<string, unknown>;

  /**
   * Hora del telefono al encolar la operacion. Contra synced_at_server da el
   * tiempo que el guardia estuvo sin señal.
   */
  @IsISO8601()
  queuedAt!: string;
}

export class PushBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(SYNC_BATCH_CEILING)
  @ValidateNested({ each: true })
  @Type(() => SyncOperationDto)
  operations!: SyncOperationDto[];
}
