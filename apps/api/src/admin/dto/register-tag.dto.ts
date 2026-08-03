import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class RegisterTagDto {
  /** UID leido de la etiqueta al escanearla durante la instalacion. */
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  uid!: string;

  @IsOptional()
  @IsIn(['nfc', 'qr'])
  tech?: 'nfc' | 'qr';
}

export class ResolveTagQuery {
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  uid!: string;
}
