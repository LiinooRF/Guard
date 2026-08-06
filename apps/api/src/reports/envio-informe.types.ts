/**
 * Lo que viaja a Redis para despachar el informe de una ronda (#86).
 *
 * Solo identificadores. Ni el PDF, ni los destinatarios, ni el nombre del
 * guardia: la cola retiene los jobs completados para conservar la idempotencia,
 * asi que todo lo que se escriba aca queda en Redis indefinidamente. El worker
 * resuelve destinatarios y contenido al despachar, dentro de su propia
 * transaccion con contexto de tenant — que ademas es lo correcto, porque entre
 * el cierre de la ronda y el despacho el admin pudo cambiar la lista.
 */
export interface EnvioInformeJobData {
  /** El worker no tiene request: el tenant viaja para poder abrir su RLS. */
  readonly tenantId: string;
  readonly patrolId: string;
}

/** Por que un despacho no envio nada. `null` = envio de verdad. */
export type MotivoOmision =
  | 'ronda_inexistente'
  | 'ronda_sin_cerrar'
  | 'envio_desactivado'
  | 'sin_destinatarios'
  /**
   * Habia destinatarios, pero TODOS caian en un dominio que no se despacha
   * (`.test` de las cuentas demo, o la lista de MAIL_BLOCKED_DOMAINS).
   *
   * Es un motivo aparte de `sin_destinatarios` y no un detalle: los dos
   * arreglos son opuestos. "Sin destinatarios" se arregla dandole un correo al
   * admin de la empresa; este se arregla NO dandoselo — la empresa es una demo
   * y el sistema hizo bien en callarse. Si compartieran motivo, el operador de
   * turno le cargaria mas direcciones `@demo-andina.test` al tenant demo, que
   * es exactamente el rebote duro que estamos evitando.
   */
  | 'dominio_no_despachable'
  | 'ya_enviado';

export interface ResultadoEnvio {
  readonly patrolId: string;
  /** Correos con el informe normal encolados en ESTE despacho. */
  readonly informes: number;
  /** Alertas bajo umbral encoladas en ESTE despacho. */
  readonly alertas: number;
  /** false cuando el PDF supero el maximo y el correo salio sin adjunto. */
  readonly adjunto: boolean;
  /**
   * Destinatarios que se descartaron por su dominio en ESTE despacho.
   *
   * Va en el resultado y no solo en el log porque tambien puede ser PARCIAL: un
   * tenant demo con un admin real y tres de prueba envia de verdad y ademas
   * suprime tres. Ese caso no deja ninguna otra huella consultable.
   */
  readonly suprimidos: number;
  readonly omitido: MotivoOmision | null;
}

/** Despacho que no envio nada, con el motivo. */
export function omitir(
  patrolId: string,
  motivo: MotivoOmision,
  suprimidos = 0,
): ResultadoEnvio {
  return { patrolId, informes: 0, alertas: 0, adjunto: false, suprimidos, omitido: motivo };
}

/** Tipo de correo. Son dos hechos distintos y se registran por separado. */
export type TipoEnvio = 'informe' | 'alerta';

export interface DestinatarioEnvio {
  readonly kind: TipoEnvio;
  /** Siempre normalizado a minusculas y sin espacios. */
  readonly email: string;
  /** Nulo cuando el correo viene de las reglas y no de un usuario del sistema. */
  readonly userId: string | null;
}
