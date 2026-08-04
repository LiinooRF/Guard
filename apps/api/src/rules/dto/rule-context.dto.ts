import { IsOptional, IsUUID } from 'class-validator';

/**
 * Contexto del endpoint de configuracion efectiva. Los dos son opcionales:
 * sin ninguno devuelve las reglas de la empresa, con el punto solo la cascada
 * completa igual resuelve el recinto — el punto sabe a que recinto pertenece.
 */
export class EffectiveRulesQuery {
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @IsOptional()
  @IsUUID()
  checkpointId?: string;
}

export class SiteIdParam {
  @IsUUID()
  siteId!: string;
}

export class CheckpointIdParam {
  @IsUUID()
  checkpointId!: string;
}
