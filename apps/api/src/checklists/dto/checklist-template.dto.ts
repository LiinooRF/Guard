import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export const CHECKLIST_RESPONSE_TYPES = ['ok_falla', 'texto', 'numero'] as const;
export type ChecklistResponseType = (typeof CHECKLIST_RESPONSE_TYPES)[number];

export class ChecklistItemDto {
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
}

export class CreateChecklistTemplateDto {
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
