import { z } from 'zod';

import type { PatrolRules } from './rules';

/**
 * Entidades del dominio de VoxIA Control.
 *
 * El mundo fisico que el sistema monitorea:
 *
 *     Tenant (empresa)
 *       └─ Site (recinto / sucursal)
 *            └─ Checkpoint (punto de control)  ──  Tag (etiqueta NFC pegada ahi)
 *
 * Y la operacion:
 *
 *     Route (secuencia de puntos)  ->  Shift (ruta + guardia + ventana horaria)
 *       ->  Patrol (la ejecucion concreta)  ->  Scan (cada punto escaneado)
 *
 * Ver issues #10 (catalogo) y #12 (motor de rondas).
 */

export const uuid = z.string().uuid();
export const isoDateTime = z.string().datetime({ offset: true });

// --------------------------------------------------------------- puntos

/**
 * Un punto critico (acceso, puerta, porteria) exige fotografia para confirmar el
 * estado del acceso. Es lo que el cliente final revisa cuando algo pasa.
 */
export const checkpointKindSchema = z.enum(['normal', 'acceso_critico']);
export type CheckpointKind = z.infer<typeof checkpointKindSchema>;

export const geoPointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
export type GeoPoint = z.infer<typeof geoPointSchema>;

export const checkpointSchema = z.object({
  id: uuid,
  tenantId: uuid,
  siteId: uuid,
  name: z.string().min(1).max(120),
  kind: checkpointKindSchema.default('normal'),
  location: geoPointSchema.nullable(),
  /** Sobreescribe la regla global de foto para este punto en particular. */
  requiresPhoto: z.boolean().nullable().default(null),
  /** Que tiene que revisar el guardia aca. */
  instructions: z.string().max(500).nullable().default(null),
});
export type Checkpoint = z.infer<typeof checkpointSchema>;

// --------------------------------------------------------------- etiquetas

/**
 * Un Android lee SOLO NFC (13.56 MHz). RFID UHF o de 125 kHz necesita un lector
 * externo: otro hardware, otro presupuesto y otro plazo. Confirmar antes de
 * comprar etiquetas (spike en issue #10).
 */
export const tagTechSchema = z.enum(['nfc', 'qr']);
export type TagTech = z.infer<typeof tagTechSchema>;

export const tagSchema = z.object({
  id: uuid,
  tenantId: uuid,
  checkpointId: uuid,
  tech: tagTechSchema,
  /** UID de la etiqueta. Unico entre etiquetas activas, en todos los tenants. */
  uid: z.string().min(4).max(64),
  active: z.boolean().default(true),
  installedAt: isoDateTime,
});
export type Tag = z.infer<typeof tagSchema>;

// --------------------------------------------------------------- escaneos

export const scanMethodSchema = tagTechSchema;

/**
 * Marcas de anomalia. El sistema NO rechaza el escaneo: lo marca y avisa al
 * supervisor, que decide.
 *
 * El fraude en rondas es EL problema conocido del rubro: el guardia que se lleva
 * las etiquetas a la caseta y las escanea todas juntas. Sin esta deteccion, el
 * sistema da una falsa sensacion de control, que es peor que no tener sistema.
 *
 * Ver issue #11.
 */
export const scanAnomalySchema = z.enum([
  'fuera_de_radio_gps',
  'sin_fix_gps',
  'velocidad_imposible',
  'reloj_desfasado',
  'dispositivo_duplicado',
]);
export type ScanAnomaly = z.infer<typeof scanAnomalySchema>;

export const scanSchema = z.object({
  /**
   * UUID generado EN EL DISPOSITIVO. El servidor deduplica por este campo, asi
   * que reenviar la cola es seguro: una ronda sincronizada tres veces deja un
   * solo registro por escaneo. Ver issue #14.
   */
  clientId: uuid,
  id: uuid.nullable().default(null),
  tenantId: uuid,
  patrolId: uuid,
  checkpointId: uuid,
  tagUid: z.string().min(4).max(64),
  method: scanMethodSchema,
  /** Hora del telefono: puede estar manipulada o simplemente mal. */
  scannedAt: isoDateTime,
  /** Hora en que el servidor lo recibio. Permite detectar relojes desfasados. */
  receivedAt: isoDateTime.nullable().default(null),
  location: geoPointSchema.nullable(),
  gpsAccuracyM: z.number().nonnegative().nullable().default(null),
  anomalies: z.array(scanAnomalySchema).default([]),
});
export type Scan = z.infer<typeof scanSchema>;

// --------------------------------------------------------------- rondas

export const patrolStatusSchema = z.enum([
  'pendiente',
  'en_curso',
  'completada',
  'incompleta',
  'vencida',
]);
export type PatrolStatus = z.infer<typeof patrolStatusSchema>;

export const patrolSchema = z.object({
  id: uuid,
  tenantId: uuid,
  siteId: uuid,
  routeId: uuid,
  shiftId: uuid.nullable(),
  guardId: uuid,
  status: patrolStatusSchema,
  startedAt: isoDateTime.nullable(),
  closedAt: isoDateTime.nullable(),
  /** Orden efectivo: se sortea al generar la ronda si el tenant usa orden aleatorio. */
  expectedCheckpointIds: z.array(uuid),
  compliancePct: z.number().min(0).max(100).nullable().default(null),
});
export type Patrol = z.infer<typeof patrolSchema>;

// --------------------------------------------------------------- cumplimiento

export interface ComplianceResult {
  expected: number;
  scanned: number;
  /** Escaneados sin ninguna marca de anomalia. */
  clean: number;
  pct: number;
  /** Puntos que faltaron, identificados uno por uno y no solo contados. */
  missedCheckpointIds: string[];
  /** true si hay que enviar el informe DIRECTO al admin. */
  belowThreshold: boolean;
}

/**
 * Calcula el cumplimiento de una ronda.
 *
 * Decision explicita: los escaneos con anomalia SI cuentan como cumplidos, pero
 * quedan marcados en el informe para que una persona decida. Descartarlos
 * automaticamente castigaria al guardia por un GPS impreciso en un subterraneo,
 * que es una condicion normal de trabajo y no un fraude.
 *
 * Ver issue #12.
 */
export function computeCompliance(
  expectedCheckpointIds: readonly string[],
  scans: readonly Pick<Scan, 'checkpointId' | 'anomalies'>[],
  complianceThreshold: number,
): ComplianceResult {
  const expected = expectedCheckpointIds.length;
  const scannedIds = new Set(scans.map((s) => s.checkpointId));
  const cleanIds = new Set(
    scans.filter((s) => s.anomalies.length === 0).map((s) => s.checkpointId),
  );

  const matched = expectedCheckpointIds.filter((id) => scannedIds.has(id));
  const pct = expected === 0 ? 0 : Math.round((matched.length / expected) * 100);

  return {
    expected,
    scanned: matched.length,
    clean: expectedCheckpointIds.filter((id) => cleanIds.has(id)).length,
    pct,
    missedCheckpointIds: expectedCheckpointIds.filter((id) => !scannedIds.has(id)),
    belowThreshold: pct < complianceThreshold,
  };
}

// --------------------------------------------------------------- horario habil

export const businessHoursSchema = z.object({
  /** 0 = domingo ... 6 = sabado */
  weekday: z.number().int().min(0).max(6),
  /** "HH:mm" en la zona horaria DEL RECINTO, no del servidor ni del telefono. */
  opensAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  closesAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});
export type BusinessHours = z.infer<typeof businessHoursSchema>;

/**
 * Decide si la foto es obligatoria en un punto.
 *
 * Requisito explicito del cliente: en horario NO habil la foto es obligatoria si
 * o si, en todos los puntos. En horario habil, solo en los criticos.
 *
 * Ver issue #13.
 */
export function isPhotoRequired(args: {
  checkpoint: Pick<Checkpoint, 'kind' | 'requiresPhoto'>;
  withinBusinessHours: boolean;
  rules: Pick<PatrolRules, 'photoRequiredOutsideHours' | 'photoRequiredOnCritical'>;
}): boolean {
  const { checkpoint, withinBusinessHours, rules } = args;

  // El punto puede sobreescribir la regla global en cualquier direccion.
  if (checkpoint.requiresPhoto !== null) return checkpoint.requiresPhoto;

  if (!withinBusinessHours && rules.photoRequiredOutsideHours) return true;
  if (checkpoint.kind === 'acceso_critico' && rules.photoRequiredOnCritical) return true;

  return false;
}
