import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * Criticidades que admiten cadena. 'info' y 'baja' quedan fuera a proposito:
 * son bitacora, no alarma.
 */
export const ESCALATION_CRITICALITIES = ['media', 'alta', 'panico'] as const;
export type EscalationCriticality = (typeof ESCALATION_CRITICALITIES)[number];

export const NOTIFY_ROLES = ['SUPERVISOR', 'ADMIN'] as const;
export type NotifyRole = (typeof NOTIFY_ROLES)[number];

export class EscalationLevelDto {
  @IsInt()
  @Min(1)
  @Max(3)
  level!: number;

  /** Destino por rol: se resuelve a las personas vigentes al momento del evento. */
  @IsOptional()
  @IsIn(NOTIFY_ROLES)
  notifyRole?: NotifyRole;

  /** Destino fijo para una central de monitoreo que no es usuario del sistema. */
  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  notifyEmail?: string;

  /** Minutos sin acuse antes de que este nivel entre. 0 = inmediato. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1440)
  delayMinutes?: number;
}

export class EscalationChainDto {
  @IsIn(ESCALATION_CRITICALITIES)
  criticality!: EscalationCriticality;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => EscalationLevelDto)
  levels!: EscalationLevelDto[];
}

/**
 * El body reemplaza el set COMPLETO de cadenas del tenant, igual que los
 * overrides de reglas: una criticidad omitida vuelve a la cadena por defecto.
 */
export class UpdateEscalationPoliciesDto {
  @IsArray()
  @ArrayMaxSize(3)
  @ValidateNested({ each: true })
  @Type(() => EscalationChainDto)
  chains!: EscalationChainDto[];
}
