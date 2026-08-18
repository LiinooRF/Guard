import { Type } from 'class-transformer';
import {
  IsEmail,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class ProvisionAdminDto {
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  givenName!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  familyName!: string;
}

export class ProvisionSiteDto {
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  branchName!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(240)
  address!: string;
}

export class ProvisionTenantDto {
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

  /**
   * Formato, no catalogo: los planes vigentes viven en subscription_plans y la
   * FK de tenants los valida. Enumerarlos aca (como hace CreateTenantDto con
   * ['base','pro']) obliga a un deploy de la API para vender un plan nuevo.
   */
  @Matches(/^[a-z0-9]+(?:[_-][a-z0-9]+)*$/)
  @MinLength(2)
  @MaxLength(32)
  planKey!: string;

  @ValidateNested()
  @Type(() => ProvisionAdminDto)
  admin!: ProvisionAdminDto;

  /** Recinto de ejemplo, para que el ADMIN entre a un panel que no esta vacio. */
  @IsOptional()
  @ValidateNested()
  @Type(() => ProvisionSiteDto)
  sampleSite?: ProvisionSiteDto;

  /**
   * Desviaciones respecto de los defaults de patrolRulesSchema. Se valida con
   * el schema de @sentrycore/shared en el servicio, no con decoradores: duplicar el
   * contrato en class-validator lo desincronizaria de web y movil (mismo
   * criterio que UpdateTenantRulesPipe).
   */
  @IsOptional()
  @IsObject()
  ruleOverrides?: Record<string, unknown>;
}
