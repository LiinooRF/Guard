import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

import { normalizarUidNfc } from '../uid-nfc';

export class CreateTenantUserDto {
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @IsOptional()
  @Matches(/^[a-zA-Z0-9._-]+$/)
  @MinLength(4)
  @MaxLength(48)
  username?: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  givenName!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  familyName!: string;

  @IsIn(['SUPERVISOR', 'GUARDIA'])
  role!: 'SUPERVISOR' | 'GUARDIA';

  @IsOptional()
  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password?: string;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? (value.trim() ? normalizarUidNfc(value) : null) : value,
  )
  @IsString()
  @Matches(/^[0-9a-fA-F]{4,64}$/, { message: 'El UID NFC debe ser una cadena hexadecimal' })
  nfcCardUid?: string | null;
}

export class UpdateTenantUserDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  givenName!: string;

  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  familyName!: string;

  @IsIn(['SUPERVISOR', 'GUARDIA'])
  role!: 'SUPERVISOR' | 'GUARDIA';

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? (value.trim() ? normalizarUidNfc(value) : null) : value,
  )
  @IsString()
  @Matches(/^[0-9a-fA-F]{4,64}$/, { message: 'El UID NFC debe ser una cadena hexadecimal' })
  nfcCardUid?: string | null;
}
