import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

/**
 * Revision de una marca atrasada por el supervisor (#73).
 *
 * Las dos opciones son deliberadamente pobres: el supervisor dice si la marca
 * se explica o no se explica, y lo demas lo escribe. No existe "aceptar" porque
 * aceptar no cambia el cumplimiento de una ronda ya cerrada (ver
 * late-scan.policy.ts); si existiera el boton, alguien esperaria que lo hiciera.
 */
export const REVIEW_DECISIONS = ['justificado', 'no_justificado'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export class ReviewLateScanDto {
  @IsIn(REVIEW_DECISIONS)
  decision!: ReviewDecision;

  /** Por que se decidio asi. Queda en la ficha de la marca, no en el log. */
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Recinto sobre el que se pide la bandeja. Sale de la query, no de la sesion. */
export class LateScansQueryDto {
  @IsUUID()
  siteId!: string;
}

export class LateScanParamDto {
  @IsUUID()
  id!: string;
}
