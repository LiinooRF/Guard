import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

/**
 * Los cuerpos que acepta el SUPERVISOR al administrar puntos (#309).
 *
 * Son los del ADMIN con DOS campos menos, y no por prolijidad:
 *
 * · **`requiresPhoto` no entra en el alta.** Junto con `kind`, gobierna
 *   `isPhotoRequired()` (packages/shared/src/domain.ts): un override en `false`
 *   gana sobre la cascada en cualquier direccion. Con ese campo, un supervisor
 *   apagaria la foto obligatoria de un acceso critico sin pasar por ninguna
 *   pantalla de reglas — y la foto es justamente lo que impide que el guardia
 *   reuse la imagen del mes pasado. El punto nace heredando la cascada; el
 *   override sigue siendo del ADMIN (`PATCH /admin/checkpoints/:id/photo`).
 * · **`kind` no entra en la EDICION.** Queda de escritura unica: el punto puede
 *   nacer critico, pero degradarlo a `normal` —que apaga la foto por la otra
 *   via— sigue siendo del ADMIN.
 *
 * No se hereda de los DTO del ADMIN con un `Omit`: los decoradores de
 * class-validator se heredan con la clase, asi que una subclase no puede quitar
 * un campo. Se declaran completos a proposito.
 *
 * Tampoco llevan `siteId`: el recinto sale de la URL, que es la que se comprobo
 * contra `supervisor_sites`. Con `forbidNonWhitelisted: true` (main.ts:23)
 * cualquiera de los tres campos colado en el cuerpo es un 400, no un campo
 * ignorado — la defensa no depende de que nadie olvide un `delete`.
 */
export class CrearPuntoSupervisorDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  /** `acceso_critico` hereda foto obligatoria de las reglas del tenant. */
  @IsOptional()
  @IsIn(['normal', 'acceso_critico'])
  kind?: 'normal' | 'acceso_critico';

  @IsOptional()
  @IsInt()
  @Min(0)
  suggestedOrder?: number;

  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @IsLongitude()
  longitude?: number;

  /** Que tiene que revisar el guardia en este punto. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  instructions?: string;

  /**
   * UID leido durante la instalacion; se vincula en la misma operacion.
   * Se recorta antes de validar por lo mismo que `RegisterTagDto.uid`: el CHECK
   * de `tags` mide sin recortar y el servicio inserta con `.trim()`.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  tagUid?: string;
}

/**
 * Vincular una etiqueta desde la puerta del SUPERVISOR.
 *
 * Es un DTO propio y NO `RegisterTagDto` por una sola razon, que es de
 * seguridad: aquel acepta `tech: 'nfc' | 'qr'`, y el QR de respaldo existe con
 * un UID de 16 bytes ALEATORIOS justamente para que nadie pueda imprimir el
 * codigo de un punto sin ir al recinto. Si el llamador puede elegir el UID de un
 * QR, un supervisor se emite el codigo, lo pega en la garita, y sus guardias
 * marcan la ronda entera sin caminar — que es exactamente el fraude que el
 * producto existe para impedir.
 *
 * Aca solo viaja el UID. La tecnologia la fija el servidor en 'nfc' y no se
 * acepta como entrada. El alta de QR sigue siendo del ADMIN, que ademas pasa por
 * la regla `allowQrFallback` del tenant.
 */
export class VincularEtiquetaSupervisorDto {
  /** Se recorta antes de validar, por lo mismo que `RegisterTagDto.uid`. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  uid!: string;
}

export class EditarPuntoSupervisorDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  suggestedOrder?: number;

  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @IsLongitude()
  longitude?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  instructions?: string;
}

export class ImportarPuntoSupervisorRowDto {
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @IsOptional()
  @IsIn(['normal', 'acceso_critico'])
  kind?: 'normal' | 'acceso_critico';

  @IsOptional()
  @IsInt()
  @Min(0)
  suggestedOrder?: number;

  @IsOptional()
  @IsLatitude()
  latitude?: number;

  @IsOptional()
  @IsLongitude()
  longitude?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  instructions?: string;

  /** Se recorta ANTES de validar: el patron acepta el espacio y el CHECK de
   * `tags` mide sin recortar. Ver ImportCheckpointRowDto. */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsOptional()
  @Matches(/^[\x20-\x7E]{4,64}$/)
  tagUid?: string;
}

export class ImportarPuntosSupervisorDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => ImportarPuntoSupervisorRowDto)
  checkpoints!: ImportarPuntoSupervisorRowDto[];
}
