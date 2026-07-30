import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

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

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  password!: string;
}
