import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ChecklistResponseDto {
  @IsUUID()
  itemId!: string;

  /** En un item 'ok_falla' vale 'ok' o 'falla'; en los demas, la lectura. */
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  value!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  /**
   * Solo se considera en 'texto' y 'numero'. En 'ok_falla' la falla la deduce el
   * servidor del valor: si viniera del cliente, una app vieja o modificada
   * podria reportar 'falla' sin marcar la falla, y el supervisor no se entera.
   */
  @IsOptional()
  @IsBoolean()
  failed?: boolean;

  /** Foto ya subida de esta ronda. Obligatoria si el item la exige siempre o al fallar. */
  @IsOptional()
  @IsUUID()
  photoId?: string;
}

/**
 * Se manda el checklist completo o por partes: cada item lleva su propio
 * veredicto y uno invalido no bota a los demas, mismo criterio que el lote de
 * sincronizacion offline (#14).
 */
export class SubmitChecklistDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ChecklistResponseDto)
  responses!: ChecklistResponseDto[];
}
