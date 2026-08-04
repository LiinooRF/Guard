import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

import { REGISTRO_LIMITE_MAXIMO } from './registro-envios.constants';
import { ESTADOS_ENVIO, EVENTOS_PROVEEDOR } from './registro-envios.types';

const FECHA_LOCAL = /^\d{4}-\d{2}-\d{2}$/;

export class RondaParam {
  @IsUUID()
  patrolId!: string;
}

/**
 * Filtros de la vista de soporte (#44).
 *
 * `desde`/`hasta` son FECHAS (AAAA-MM-DD), no instantes: el periodo se
 * interpreta en la zona horaria del RECINTO (sites.timezone) y por eso el
 * servicio exige `siteId` cuando alguna de las dos viene. Misma decision que
 * OffShiftAuditQuery, y por la misma razon: un recinto en Santiago y otro en
 * Isla de Pascua no empiezan el dia a la misma hora.
 */
export class RegistroEnviosQuery {
  /**
   * Acota a los correos de ese recinto, MAS los que no son de ninguna ronda
   * (invitaciones, claves, escalamientos): un correo solo tiene recinto si tiene
   * ronda, y esconderlos detras de un filtro que no les aplica vaciaria la vista
   * apenas se acota por fechas, que es lo que obliga a mandar este campo.
   */
  @IsOptional()
  @IsUUID()
  siteId?: string;

  @IsOptional()
  @IsIn(ESTADOS_ENVIO)
  estado?: (typeof ESTADOS_ENVIO)[number];

  @IsOptional()
  @IsString()
  @MaxLength(80)
  plantilla?: string;

  @IsOptional()
  @Matches(FECHA_LOCAL, { message: 'La fecha de inicio debe venir como AAAA-MM-DD' })
  desde?: string;

  /** Inclusivo: el dia indicado entra completo. */
  @IsOptional()
  @Matches(FECHA_LOCAL, { message: 'La fecha de término debe venir como AAAA-MM-DD' })
  hasta?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(REGISTRO_LIMITE_MAXIMO)
  limite?: number;
}

/**
 * Estado de entrega que reporta el proveedor de correo.
 *
 * Es el contrato INTERNO de ingesta, no el formato de ningun proveedor: quien
 * traduce el webhook real —cuando se cierre la decision #9— arma esta llamada y
 * la firma. Ver registro-envios.firma.ts.
 */
export class EstadoEntregaDto {
  /** Message-ID que devolvio el SMTP al enviar. Con o sin angulos. */
  @IsString()
  @MaxLength(400)
  messageId!: string;

  @IsIn(EVENTOS_PROVEEDOR)
  evento!: (typeof EVENTOS_PROVEEDOR)[number];

  /** Segundos desde epoch. Firmado, y con ventana de frescura. */
  @Type(() => Number)
  @IsInt()
  timestamp!: number;

  @IsString()
  @Matches(/^[0-9a-f]{64}$/, { message: 'La firma no tiene el formato esperado' })
  firma!: string;

  /**
   * Diagnostico del rebote, si el proveedor lo manda. Se guarda saneado: es
   * texto del servidor del destinatario y no se escribe en los logs.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  motivo?: string;
}
