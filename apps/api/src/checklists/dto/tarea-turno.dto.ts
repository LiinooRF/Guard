import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { ChecklistItemDto } from './checklist-template.dto';

/**
 * Lo que el SUPERVISOR manda para crear la plantilla de tareas de un recinto.
 *
 * NO lleva `siteId`, y eso es control de acceso, no ergonomia: el recinto sale
 * de la URL, que es la que se comprueba contra `supervisor_sites`. Si el recinto
 * viajara tambien en el cuerpo, un supervisor podria pedir
 * `POST /sites/<el-mio>/templates` con `siteId: <ajeno>` adentro; la
 * comprobacion miraria el recinto propio y la plantilla se guardaria en el otro.
 * Es la forma clasica de saltarse un alcance verificado: verificar un dato y
 * usar otro.
 *
 * El `shiftId` si viaja en el cuerpo porque el turno pertenece al recinto y el
 * servicio lo comprueba contra el (`verificarTurnoDelRecinto`).
 */
export class CrearTareasTurnoDto {
  /** Se recorta antes de validar. Ver `ChecklistItemDto.label`. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  /** Omitido = las tareas aplican a cualquier turno del recinto. */
  @IsOptional()
  @IsUUID()
  shiftId?: string;

  /** La posicion de cada tarea es su indice en este arreglo. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ChecklistItemDto)
  items!: ChecklistItemDto[];
}
