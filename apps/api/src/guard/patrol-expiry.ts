import type { PatrolRules } from '@voxia/shared';

/**
 * Cuando una ronda abierta se da por vencida. Modulo PURO.
 *
 * ------------------------------------------------------------------
 * EL BUG QUE ESTO ARREGLA: nadie escribia 'vencida', nunca.
 * ------------------------------------------------------------------
 *
 * La regla `maxPatrolDurationMin` existe desde el catalogo (#16), el admin
 * puede editarla, y su ficha promete "la ronda se marca como vencida y deja de
 * aceptar escaneos". Todo el sistema LEE ese estado —las alertas de
 * escalamiento filtran por el, las estadisticas lo cuentan, la politica de
 * escaneos tardios lo clasifica— pero ningun codigo lo escribia. Comprobado en
 * staging con una ronda real: un turno de 22:00 a 06:00 siguio `en_curso`
 * durante 48 horas, acepto escaneos a mediodia del dia subsiguiente y cerro
 * "completada" al 100%, sin una anomalia y sin una alerta.
 *
 * Eso no es un detalle: es el fraude conocido del rubro —escanear todo junto,
 * tarde— pasando por un sistema cuyo proposito es impedirlo. La propia
 * politica de atrasos lo dice (late-scan.policy.ts): "dejar que una ronda
 * vencida se complete horas despues abre la puerta al fraude".
 *
 * La evaluacion es PEREZOSA: se decide aqui y se aplica en los puntos donde la
 * ronda se toca (`guard/home`, `registerScan`). Una ronda que nadie mira se
 * vence en el momento en que alguien la mira, que es el unico momento en que
 * su estado le importa a alguien. El barrido periodico para las que nadie toca
 * (informes y alertas de rondas abandonadas) es un paso aparte.
 *
 * Los dos casos:
 *
 *   en_curso   El guardia la empezo y no la cerro. Vence `maxPatrolDurationMin`
 *              despues de INICIADA — la promesa literal de la ficha.
 *
 *   pendiente  Nunca se inicio y la ventana del turno ya paso. Se le da la
 *              misma gracia que a un escaneo tardio (`lateScanGraceMin`):
 *              empezar tarde es un atraso, no un crimen, y el sistema marca y
 *              avisa en vez de rechazar.
 */
export interface RondaAbierta {
  readonly status: string;
  readonly startedAt: Date | null;
  readonly scheduledEndAt: Date;
}

export function rondaVencida(
  ronda: RondaAbierta,
  reglas: Pick<PatrolRules, 'maxPatrolDurationMin' | 'lateScanGraceMin'>,
  ahora: Date,
): boolean {
  // Truthy y no `!== null`: las filas llegan de consultas SQL tipadas con `as`,
  // y una columna que falte llega como undefined. Ante un dato ausente la
  // respuesta segura es NO vencer — vencer de mas cierra rondas vivas.
  if (ronda.status === 'en_curso' && ronda.startedAt) {
    // Estrictamente mayor: "tras los cuales" — en el minuto exacto todavia no.
    return ahora.getTime() > ronda.startedAt.getTime() + reglas.maxPatrolDurationMin * 60_000;
  }
  if (ronda.status === 'pendiente' && ronda.scheduledEndAt) {
    return ahora.getTime() > ronda.scheduledEndAt.getTime() + reglas.lateScanGraceMin * 60_000;
  }
  return false;
}
