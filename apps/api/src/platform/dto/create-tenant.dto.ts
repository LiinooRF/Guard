import {
  IsEmail,
  IsIn,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateTenantDto {
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  @MinLength(3)
  @MaxLength(48)
  slug!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(160)
  legalName!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  displayName!: string;

  @IsIn(['base', 'pro'])
  planKey!: 'base' | 'pro';

  @IsEmail()
  @MaxLength(254)
  adminEmail!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  adminGivenName!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  adminFamilyName!: string;

  @IsString()
  @MinLength(12)
  @MaxLength(128)
  adminPassword!: string;
}
