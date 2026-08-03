import { IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength } from 'class-validator';

export class OpenSupportAccessDto {
  @IsUUID()
  tenantId!: string;

  /** Por que entras. Queda escrito y el ADMIN del tenant puede leerlo. */
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  /** Minutos de vigencia. Se topa entre 5 y 480: soporte no es sesion permanente. */
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(480)
  minutes?: number;
}
