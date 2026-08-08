/**
 * La hora de una tarea del turno (#265). Modulo PURO: sin Nest, sin SQL.
 *
 * -------------------------------------------------------------------------
 * LA REGLA, ESCRITA: se acepta tarde, pero se dice. Nunca se rechaza.
 * -------------------------------------------------------------------------
 *
 * El requisito, textual del dueño del producto (8-ago-2026):
 *
 *     "si la tarea queda fuera del horario de la ronda, que se envie igual,
 *      se puede trabajar todo igual, pero que se mencione en el informe y en
 *      todo en general"
 *
 * O sea: `late_minutes` es una MEDICION, no un veredicto. Ninguna respuesta se
 * pierde por llegar tarde, igual que un escaneo con GPS impreciso se marca y no
 * se descarta (ver CLAUDE.md, "el sistema marca y avisa, no rechaza"). Aqui no
 * hay umbral de gracia a proposito: un umbral seria una regla de negocio y
 * viviria en `rules.ts`, no en el codigo.
 *
 * ---------------------------------------------------------------- la zona
 *
 * Este modulo NO hace aritmetica de husos horarios, y esa es la decision de
 * diseño principal. La hora de la tarea (`due_local_time`) es hora de pared del
 * RECINTO, y convertir hora local a instante sin la tzdata obliga a inventar un
 * offset fijo que esta mal la mitad del año — el error que documenta
 * `scheduling.service.ts`. Por eso PostgreSQL entrega la hora ya convertida a
 * instante con `AT TIME ZONE sites.timezone`, y este modulo solo compara
 * instantes contra instantes.
 *
 * Lo que si es de este modulo es la unica parte que NO necesita la tzdata y si
 * necesita test: A QUE DIA pertenece esa hora de pared.
 *
 * -------------------------------------------------- medianoche y turno nocturno
 *
 * Un turno de 22:00 a 06:00 vive en dos dias calendario. Restar `::time` pelado
 * daria −21 h para una tarea de las 23:00 respondida a las 02:00, cuando el
 * atraso real son 3 h. Por eso PostgreSQL manda DOS candidatos —la misma hora de
 * pared anclada al dia de servicio y al siguiente— y aca se elige:
 *
 *   1. El candidato que cae DENTRO de la ventana del turno. Es el que el
 *      supervisor quiso decir: la tarea se hace durante el turno.
 *   2. Si ninguno cae dentro, el mas cercano a la VENTANA. Nunca el mas cercano
 *      a la respuesta: si el vencimiento dependiera de cuando se respondio, el
 *      guardia definiria su propia hora limite con solo responder mas tarde.
 *
 * El caso 2 es justamente el que el producto pidio mencionar: una tarea de las
 * 11:00 en un turno de 22:00 a 06:00 no es un error, es una tarea fuera del
 * horario de la ronda. Se acepta y se marca `fueraDelTurno`.
 *
 * ------------------------------------------------------- horario de verano
 *
 * Al recibir los candidatos ya convertidos, el cambio de hora no puede correr el
 * vencimiento: la ambiguedad de la hora que ocurre dos veces la resuelve la
 * tzdata del motor, que es donde queremos que se resuelva. Lo unico que puede
 * pasar aca es que la ventana del retroceso (25 h) contenga a los DOS
 * candidatos; en ese caso gana el primero, que es la primera pasada por esa
 * hora y la que el supervisor pidio.
 *
 * ------------------------------------------------------------- feriados
 *
 * Un feriado NO mueve el vencimiento, y es deliberado. `site_holidays` gobierna
 * el horario habil del recinto (de eso depende la foto fuera de horario), no la
 * nomina de turnos: si hay asignacion, el guardia esta trabajando y la tarea
 * vence a su hora. Y si el recinto no opera no hay asignacion, no hay ronda y no
 * hay nada que medir. Mirar el feriado aca haria que una tarea desapareciera del
 * informe justo el dia en que el recinto esta mas solo.
 *
 * --------------------------------------------------------------- NULL vs 0
 *
 * `null`  la tarea no tenia hora pedida: no hay atraso que medir.
 * `0`     tenia hora y se respondio a tiempo (o antes).
 * `> 0`   minutos de atraso.
 *
 * Colapsar "a tiempo" en `null` obligaria al informe a volver a mirar el item
 * para distinguir las dos cosas, y son distintas para quien lee.
 */

/** Ventana en la que la tarea corresponde: la del turno, o la de la ronda. */
export interface VentanaDelTurno {
  readonly inicio: Date;
  readonly fin: Date;
}

/**
 * La misma hora de pared anclada a dos dias calendario consecutivos, ya
 * convertida a instante por PostgreSQL. Son dos y no una porque un turno
 * nocturno cruza medianoche y la hora sola no dice a que dia pertenece.
 */
export interface CandidatosDeVencimiento {
  readonly delDia: Date;
  readonly delDiaSiguiente: Date;
}

export interface VencimientoElegido {
  readonly at: Date;
  readonly dentroDelTurno: boolean;
}

export interface VeredictoDeTarea {
  /** Minutos de atraso; `null` cuando la tarea no tenia hora pedida. */
  readonly minutosDeAtraso: number | null;
  readonly vencimiento: Date | null;
  /** La hora pedida cae fuera del horario de la ronda. Se acepta igual. */
  readonly fueraDelTurno: boolean;
  /** Texto para la pantalla del guardia y para el informe. `null` si no hay nada que decir. */
  readonly mensaje: string | null;
}

/** Una tarea sin hora no tiene atraso: no es lo mismo que llegar a tiempo. */
export const TAREA_SIN_HORA: VeredictoDeTarea = {
  minutosDeAtraso: null,
  vencimiento: null,
  fueraDelTurno: false,
  mensaje: null,
};

/**
 * A cual de los dos dias pertenece la hora pedida.
 *
 * Vive aparte y exportada porque el informe y la pantalla del supervisor van a
 * necesitar el mismo vencimiento para explicar el numero, y dos copias de este
 * criterio terminarian diciendo cosas distintas (mismo motivo por el que
 * `late-scan.policy.ts` expone `sugerenciaPara`).
 */
export function elegirVencimiento(
  candidatos: CandidatosDeVencimiento,
  ventana: VentanaDelTurno,
): VencimientoElegido {
  const ordenados = [candidatos.delDia, candidatos.delDiaSiguiente].sort(
    (a, b) => a.getTime() - b.getTime(),
  );

  const dentro = ordenados.find((candidato) => distanciaA(candidato, ventana) === 0);
  if (dentro) return { at: dentro, dentroDelTurno: true };

  // `ordenados` tiene exactamente dos elementos; el indexado con
  // noUncheckedIndexedAccess obliga a decirlo.
  const [primero, segundo] = ordenados as [Date, Date];
  const elegido =
    distanciaA(primero, ventana) <= distanciaA(segundo, ventana) ? primero : segundo;
  return { at: elegido, dentroDelTurno: false };
}

/** 0 = cae dentro de la ventana. Si no, milisegundos hasta el borde mas cercano. */
function distanciaA(instante: Date, ventana: VentanaDelTurno): number {
  const at = instante.getTime();
  if (at < ventana.inicio.getTime()) return ventana.inicio.getTime() - at;
  if (at > ventana.fin.getTime()) return at - ventana.fin.getTime();
  return 0;
}

/**
 * Cuanto atraso lleva una respuesta. No decide nada mas: quien llama guarda la
 * respuesta pase lo que pase.
 */
export function evaluarTareaDelTurno(params: {
  readonly candidatos: CandidatosDeVencimiento | null;
  readonly ventana: VentanaDelTurno;
  readonly respondidaA: Date;
}): VeredictoDeTarea {
  if (!params.candidatos) return TAREA_SIN_HORA;

  const elegido = elegirVencimiento(params.candidatos, params.ventana);
  const atrasoMs = params.respondidaA.getTime() - elegido.at.getTime();

  // Hacia arriba, igual que late-scan.policy.ts: 30 segundos de atraso son
  // "1 min", no "0 min". Y nunca negativo: responder antes no es credito, y el
  // CHECK de checklist_responses tampoco acepta negativos.
  const minutosDeAtraso = atrasoMs <= 0 ? 0 : Math.ceil(atrasoMs / 60_000);
  const fueraDelTurno = !elegido.dentroDelTurno;

  return {
    minutosDeAtraso,
    vencimiento: elegido.at,
    fueraDelTurno,
    mensaje: mensajeDeLaTarea(minutosDeAtraso, fueraDelTurno),
  };
}

/**
 * El mensaje no nombra ninguna hora de reloj a proposito: formatear "11:00" en
 * la zona del recinto exigiria la tzdata en JavaScript, que es exactamente lo
 * que este modulo evita. Los minutos no dependen de la zona.
 */
function mensajeDeLaTarea(minutosDeAtraso: number, fueraDelTurno: boolean): string | null {
  if (minutosDeAtraso === 0 && !fueraDelTurno) return null;

  const contexto = fueraDelTurno
    ? 'La hora de esta tarea queda fuera del horario de la ronda. '
    : '';
  const atraso =
    minutosDeAtraso > 0
      ? `Se respondió ${minutosDeAtraso} min después de la hora pedida.`
      : 'Se respondió antes de la hora pedida.';

  return (
    `${contexto}${atraso} La respuesta queda registrada igual: el atraso se anota y se ` +
    'menciona en el informe, no se descarta.'
  );
}
