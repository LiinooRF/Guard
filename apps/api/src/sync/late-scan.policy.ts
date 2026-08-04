/**
 * Escaneos que llegan sobre una ronda ya cerrada (#73). Modulo PURO.
 *
 * ------------------------------------------------------------------
 * LA REGLA, ESCRITA: gana la ronda cerrada. El escaneo no se pierde.
 * ------------------------------------------------------------------
 *
 * Una ronda se cierra de dos maneras: el guardia marca el punto de cierre
 * (queda 'completada') o se le acaba el tiempo (queda 'vencida' o 'incompleta').
 * En cualquiera de los dos casos, un escaneo que llega despues:
 *
 *   1. NO reabre la ronda y NO recalcula su cumplimiento. El informe ya salio
 *      y puede estar en manos del cliente; un informe que se reescribe solo
 *      deja de servir como prueba, que es exactamente para lo que existe. Y
 *      dejar que una ronda vencida se complete horas despues abre la puerta al
 *      fraude conocido del rubro: escanear todo junto al final del turno.
 *
 *   2. NO se descarta. Queda guardado en late_scans con su hora real y su
 *      clasificacion, y el supervisor lo revisa. El sistema marca y avisa, no
 *      rechaza (ver CLAUDE.md).
 *
 * La clasificacion es lo que separa el caso justo del sospechoso:
 *
 *   dentro_de_la_ventana  El escaneo OCURRIO antes del cierre y llego tarde.
 *                         El guardia hizo su trabajo a tiempo; lo que llego
 *                         tarde fue la red. Es lo que pasa cuando la ronda se
 *                         hace entera en un subterraneo y la ronda vence
 *                         mientras el telefono no tiene señal.
 *
 *   dentro_de_gracia      El escaneo ocurrio despues del cierre, pero dentro
 *                         del plazo que la empresa considera razonable
 *                         (lateScanGraceMin). Se registra y se revisa.
 *
 *   fuera_de_plazo        El escaneo ocurrio bastante despues del cierre. Es el
 *                         antecedente que el supervisor tiene que mirar.
 *
 * El instante que se compara es el CORREGIDO por el desfase de reloj
 * (device-clock.ts), no la hora cruda del telefono: si no, bastaria con
 * atrasarle la hora al telefono para que todo escaneo pareciera hecho a tiempo.
 */

export const ESTADOS_DE_RONDA_CERRADA = ['completada', 'incompleta', 'vencida'] as const;
export type EstadoDeRondaCerrada = (typeof ESTADOS_DE_RONDA_CERRADA)[number];

export function esRondaCerrada(status: string): status is EstadoDeRondaCerrada {
  return (ESTADOS_DE_RONDA_CERRADA as readonly string[]).includes(status);
}

export const CLASIFICACIONES_DE_ATRASO = [
  'dentro_de_la_ventana',
  'dentro_de_gracia',
  'fuera_de_plazo',
] as const;
export type ClasificacionDeAtraso = (typeof CLASIFICACIONES_DE_ATRASO)[number];

/** Lo que el sistema le sugiere al supervisor. La decision sigue siendo suya. */
export type SugerenciaDeRevision = 'justificado' | 'revisar';

export interface RondaCerrada {
  readonly status: EstadoDeRondaCerrada;
  readonly closedAt: Date | null;
  readonly scheduledEndAt: Date;
}

export interface VeredictoDeAtraso {
  readonly clasificacion: ClasificacionDeAtraso;
  /** Minutos entre el cierre de la ronda y el instante real del escaneo. */
  readonly minutosDeAtraso: number;
  readonly sugerencia: SugerenciaDeRevision;
  /** Texto que viaja al telefono y queda en la bitacora. */
  readonly mensaje: string;
}

const ETIQUETA_DE_CIERRE: Record<EstadoDeRondaCerrada, string> = {
  completada: 'cerrada en el punto de cierre',
  incompleta: 'cerrada incompleta',
  vencida: 'vencida por tiempo',
};

/**
 * Clasifica un escaneo que llego sobre una ronda cerrada.
 *
 * La referencia es el cierre EFECTIVO (closed_at) y no el fin programado: una
 * ronda que el guardia cerro a las 22:30 con ventana hasta las 23:00 esta
 * cerrada desde las 22:30, y un escaneo de las 22:45 ocurrio despues del cierre
 * aunque caiga dentro de la ventana. Cuando no hay closed_at —una ronda que
 * vencio sin que nadie la cerrara— manda el fin programado.
 */
export function evaluarEscaneoAtrasado(
  ronda: RondaCerrada,
  instanteReal: Date,
  graciaMin: number,
): VeredictoDeAtraso {
  const cierre = ronda.closedAt ?? ronda.scheduledEndAt;
  const atrasoMs = instanteReal.getTime() - cierre.getTime();
  const graciaMs = Math.max(0, Math.round(graciaMin * 60_000));

  const clasificacion: ClasificacionDeAtraso =
    atrasoMs <= 0
      ? 'dentro_de_la_ventana'
      : atrasoMs <= graciaMs
        ? 'dentro_de_gracia'
        : 'fuera_de_plazo';

  // Hacia arriba: 30 segundos de atraso son "1 min", no "0 min". Un cero seria
  // decirle al supervisor que llego a tiempo cuando no llego a tiempo.
  const minutosDeAtraso = atrasoMs <= 0 ? 0 : Math.ceil(atrasoMs / 60_000);

  return {
    clasificacion,
    minutosDeAtraso,
    sugerencia: sugerenciaPara(clasificacion),
    mensaje: mensajeDeAtraso(ronda.status, clasificacion, minutosDeAtraso, graciaMin),
  };
}

/**
 * Lo unico que justifica solo es que el escaneo se haya HECHO a tiempo. Como se
 * cerro la ronda no cambia eso: la falta de señal no es culpa del guardia en
 * ninguno de los dos casos.
 *
 * Vive aparte porque la bandeja del supervisor la vuelve a calcular al listar,
 * y dos copias de este criterio terminarian diciendo cosas distintas.
 */
export function sugerenciaPara(clasificacion: ClasificacionDeAtraso): SugerenciaDeRevision {
  return clasificacion === 'dentro_de_la_ventana' ? 'justificado' : 'revisar';
}

function mensajeDeAtraso(
  status: EstadoDeRondaCerrada,
  clasificacion: ClasificacionDeAtraso,
  minutosDeAtraso: number,
  graciaMin: number,
): string {
  const cabecera = `La ronda ya estaba ${ETIQUETA_DE_CIERRE[status]} cuando llegó esta marca.`;
  const detalle =
    clasificacion === 'dentro_de_la_ventana'
      ? 'La marca se hizo antes del cierre: llegó tarde por falta de señal, no se hizo tarde.'
      : clasificacion === 'dentro_de_gracia'
        ? `La marca se hizo ${minutosDeAtraso} min después del cierre, dentro del plazo de ` +
          `${graciaMin} min que acepta tu empresa.`
        : `La marca se hizo ${minutosDeAtraso} min después del cierre, fuera del plazo de ` +
          `${graciaMin} min que acepta tu empresa.`;

  return (
    `${cabecera} ${detalle} Quedó guardada como marca atrasada para que la revise tu ` +
    'supervisor: no se perdió, y el cumplimiento ya informado de esa ronda no cambia.'
  );
}
