import { Transform } from 'class-transformer';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';

export class LoginDto {
  @Transform(({ value }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @Length(3, 254)
  identity!: string;

  @IsString()
  @Length(8, 128)
  password!: string;

  @IsOptional()
  @IsUUID()
  tenantId?: string;
}
