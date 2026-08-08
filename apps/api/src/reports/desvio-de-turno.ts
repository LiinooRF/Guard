/**
 * Cuanto se salio del horario del turno una marca. Modulo PURO.
 *
 * -------------------------------------------------------------------
 * LA REGLA: se acepta igual, pero queda dicho.
 * -------------------------------------------------------------------
 *
 * Requisito del dueño del producto (8-ago-2026), textual:
 *
 *     "puede haber un guardia que tenga la ronda de la tarde, y se vaya 10
 *      minutos despues; debe quedar registrado que marco 10 minutos despues"
 *     "se debe subir igual, pero dejar eso claro en el informe"
 *
 * Antes de esto, el informe mostraba la HORA del escaneo (22:10) y nada mas: si
 * el turno cerraba a las 22:00, la resta la hacia el supervisor a mano, punto
 * por punto, en cada ronda. Y la anomalia `fuera_de_turno` no tapaba el hueco:
 * solo marca cuando se pasa de la gracia (120 min por defecto), asi que diez
 * minutos no dejaban ninguna huella.
 *
 * Este modulo NO decide nada: no rechaza, no bloquea, no marca anomalias. Solo
 * mide y redacta. La aceptacion del escaneo ocurre siempre, aguas arriba.
 *
 * Cero es cero: una marca dentro de la ventana devuelve `null` y el informe no
 * dice nada. Agregar "0 min de desvio" en 40 puntos seria ruido que tapa los
 * dos que si importan.
 */

export interface DesvioDeTurno {
  /** Minutos fuera de la ventana. Siempre positivo; el lado lo dice `borde`. */
  readonly minutos: number;
  /** Contra que extremo se midio. */
  readonly borde: 'antes_del_inicio' | 'despues_del_cierre';
  /** Texto listo para el informe, ya redactado. */
  readonly texto: string;
}

/**
 * @param instante  Cuando ocurrio la marca (hora del servidor).
 * @param ventana   Inicio y fin PROGRAMADOS del turno de esa ronda.
 */
export function desvioDeTurno(
  instante: Date | null,
  ventana: { desde: Date | null; hasta: Date | null },
): DesvioDeTurno | null {
  if (!instante || Number.isNaN(instante.getTime())) return null;

  const t = instante.getTime();
  const desde = ventana.desde?.getTime();
  const hasta = ventana.hasta?.getTime();

  if (desde !== undefined && !Number.isNaN(desde) && t < desde) {
    // Hacia arriba: 30 segundos son "1 min", no "0 min". Un cero aqui seria
    // decir que llego a tiempo cuando no llego a tiempo.
    const minutos = Math.ceil((desde - t) / 60_000);
    return {
      minutos,
      borde: 'antes_del_inicio',
      texto: `${redactarDuracion(minutos)} antes del inicio del turno`,
    };
  }

  if (hasta !== undefined && !Number.isNaN(hasta) && t > hasta) {
    const minutos = Math.ceil((t - hasta) / 60_000);
    return {
      minutos,
      borde: 'despues_del_cierre',
      texto: `${redactarDuracion(minutos)} después del cierre del turno`,
    };
  }

  return null;
}

/**
 * El atraso de una TAREA con hora limite, redactado igual que el desvio del
 * turno. Mismo requisito, misma respuesta: se sube igual y se dice en el
 * informe.
 *
 * Vive aqui y no en el carril de las tareas para que las dos cosas se digan
 * IGUAL en el mismo PDF. Un informe que escriba "10 min despues del cierre del
 * turno" en una linea y "atraso: 90" en la siguiente obliga a quien lo lee a
 * traducir dos formatos en una sola pagina.
 *
 * Los minutos los calcula el servidor al guardar la respuesta (`late_minutes`),
 * con la zona horaria DEL RECINTO: aqui solo se redactan. Duplicar el calculo
 * seria tener dos relojes que se van a separar.
 *
 * Una tarea respondida ANTES de su hora no es un desvio: una hora limite es de
 * un solo lado. Adelantarse a la tarea de las 11:00 y hacerla a las 10:45 es
 * trabajo hecho, no una observacion que el supervisor deba revisar.
 *
 * @param minutos `late_minutes` de la respuesta: null o 0 = a tiempo.
 */
export function redactarAtrasoDeTarea(minutos: number | null | undefined): string | null {
  if (minutos === null || minutos === undefined || minutos <= 0) return null;
  return `${redactarDuracion(minutos)} después de la hora pedida`;
}

/**
 * "10 min", "1 h 30 min", "3 h". En minutos sueltos, un desvio de 190 minutos
 * obliga a dividir mentalmente para entender que fueron tres horas — y quien
 * lee el informe suele ser quien tiene que decidir algo con ese numero.
 */
function redactarDuracion(minutos: number): string {
  if (minutos < 60) return `${minutos} min`;
  const horas = Math.floor(minutos / 60);
  const resto = minutos % 60;
  return resto === 0 ? `${horas} h` : `${horas} h ${resto} min`;
}
