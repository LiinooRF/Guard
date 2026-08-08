import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const CHECKLIST_RESPONSE_TYPES = ['ok_falla', 'texto', 'numero'] as const;
export type ChecklistResponseType = (typeof CHECKLIST_RESPONSE_TYPES)[number];

export class ChecklistItemDto {
  /**
   * Se recorta ANTES de validar: ChecklistsService guarda `item.label.trim()` y
   * el CHECK de la columna es `length(trim(label)) BETWEEN 2 AND 200`. Sin el
   * recorte, un ` a` medía 2 para el validador y 1 para PostgreSQL — un 500 en
   * vez del 400 que corresponde.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  label!: string;

  @IsIn(CHECKLIST_RESPONSE_TYPES)
  responseType!: ChecklistResponseType;

  /** Solo tiene efecto cuando la respuesta queda marcada como falla. */
  @IsOptional()
  @IsBoolean()
  requiresPhotoOnFail?: boolean;

  /**
   * Donde se hace la tarea (#265). Omitido = tarea general del turno, que se
   * responde al cierre; con punto, la tarea aparece al escanear ESE punto.
   *
   * El servicio comprueba ademas que el punto sea DEL RECINTO de la plantilla:
   * la FK de la migracion solo garantiza que sea del mismo tenant, asi que sin
   * esa comprobacion se pueden guardar tareas que ninguna ronda alcanza.
   */
  @IsOptional()
  @IsUUID()
  checkpointId?: string;

  /**
   * A que hora toca, `HH:MM` de 24 horas, en la zona DEL RECINTO.
   *
   * Se valida con un patron propio y no con `@IsMilitaryTime()` porque ese
   * decorador acepta tambien `HH:MM:SS`, y la columna es `time`: guardar
   * segundos aqui haria que el editor releyera "11:00:30" donde el supervisor
   * escribio "11:00". El formato que entra es exactamente el que sale.
   */
  @IsOptional()
  @Matches(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, {
    message: 'La hora de la tarea va en formato HH:MM de 24 horas',
  })
  dueLocalTime?: string;

  /**
   * Foto SIEMPRE, este todo bien o mal. Distinta de `requiresPhotoOnFail`:
   * "fotografiar el refrigerador" es evidencia del estado normal, no de una
   * falla. Las dos pueden convivir en el mismo item.
   */
  @IsOptional()
  @IsBoolean()
  requiresPhoto?: boolean;
}

export class CreateChecklistTemplateDto {
  /** Se recorta antes de validar. Ver `ChecklistItemDto.label`. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  /** Omitido = la plantilla aplica a toda la empresa. */
  @IsOptional()
  @IsUUID()
  siteId?: string;

  /** Omitido = cualquier turno. Exige `siteId`: un turno pertenece a un recinto. */
  @IsOptional()
  @IsUUID()
  shiftId?: string;

  /** La posicion de cada item es su indice en este arreglo. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ChecklistItemDto)
  items!: ChecklistItemDto[];
}

/**
 * El ALCANCE (recinto y turno) no se edita: una plantilla que cambia de recinto
 * dejaria respuestas ya registradas colgando de una pregunta que ahi nunca se
 * hizo. Para mover el alcance se desactiva esta y se crea otra.
 */
export class UpdateChecklistTemplateDto {
  /** Se recorta antes de validar. Ver `ChecklistItemDto.label`. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  /** Si viene, reemplaza la lista completa. Se rechaza si ya hay respuestas. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ChecklistItemDto)
  items?: ChecklistItemDto[];
}
