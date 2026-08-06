import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterTagDto {
  /**
   * UID leido de la etiqueta al escanearla durante la instalacion.
   *
   * Se recorta ANTES de validar. Aca la asimetria va al reves que en el aviso de
   * GPS: el CHECK mide SIN recortar (`length(uid) BETWEEN 4 AND 64`,
   * 1723647600000-CreateNfcTags.ts:30) y es AdminService el que recorta antes de
   * insertar (`input.uid.trim()`, admin.service.ts:748). Un `"  ab"` medía 4
   * para el validador y llegaba a PostgreSQL midiendo 2 -> 500 en vez de 400.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  uid!: string;

  @IsOptional()
  @IsIn(['nfc', 'qr'])
  tech?: 'nfc' | 'qr';
}

export class ResolveTagQuery {
  /**
   * Solo resuelve (SELECT): no escribe en `tags`, asi que no hay CHECK que
   * violar. Se recorta igual para que la busqueda mida lo mismo que el alta —
   * `resolveTag()` ya hacia `uid.trim()` sobre este valor.
   */
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  uid!: string;
}
