/**
 * Reloj del dispositivo (#73). Modulo PURO: sin Nest, sin base de datos.
 *
 * El error que esto corrige: hasta ahora el desfase se estimaba comparando la
 * hora del ESCANEO contra la hora del servidor al recibirlo. Esas dos marcas se
 * separan por dos motivos distintos que no se pueden sumar:
 *
 *   - el reloj del telefono esta mal puesto  (lo que queremos detectar)
 *   - la operacion estuvo horas encolada sin señal  (condicion normal de trabajo)
 *
 * Una ronda hecha en un subterraneo y sincronizada 3 horas despues daba 3 horas
 * de "desfase" con el reloj impecable. Por eso la medicion necesita un dato mas:
 * la hora del telefono AL ENVIAR el lote. Servidor menos esa hora es el desfase
 * del reloj y nada mas.
 *
 * Convencion de signo, una sola vez y para todo el modulo:
 *
 *     offsetMs = servidor - dispositivo
 *
 * Positivo = el telefono va ATRASADO. Corregir un instante del dispositivo es
 * entonces sumarle el offset.
 */

/** Desfase medido entre el reloj del telefono y el del servidor. */
export interface MedicionDeReloj {
  /** servidor - dispositivo, en milisegundos. Positivo = telefono atrasado. */
  readonly offsetMs: number;
  /** Tolerancia vigente al medir, en milisegundos. */
  readonly toleranciaMs: number;
  /** |offsetMs| supera la tolerancia: la hora de ese telefono no es utilizable. */
  readonly desfasado: boolean;
}

export function toleranciaEnMs(toleranciaMin: number): number {
  return Math.round(toleranciaMin * 60_000);
}

/** Fecha utilizable, o null. Un ISO invalido no puede propagarse como NaN. */
export function aFecha(valor: Date | string | null | undefined): Date | null {
  if (valor === null || valor === undefined) return null;
  const fecha = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(fecha.getTime()) ? null : fecha;
}

/**
 * Mide el desfase del reloj de un dispositivo.
 *
 * Devuelve null cuando no hay con que medir: una app antigua que no manda su
 * hora de envio sigue sincronizando igual, solo que sin medicion. Nunca se
 * inventa un offset.
 */
export function medirDesfase(
  deviceReportedAt: Date | string | null | undefined,
  serverReceivedAt: Date | string | null | undefined,
  toleranciaMin: number,
): MedicionDeReloj | null {
  const dispositivo = aFecha(deviceReportedAt);
  const servidor = aFecha(serverReceivedAt);
  if (!dispositivo || !servidor) return null;

  const toleranciaMs = toleranciaEnMs(toleranciaMin);
  const offsetMs = servidor.getTime() - dispositivo.getTime();
  return {
    offsetMs,
    toleranciaMs,
    desfasado: Math.abs(offsetMs) > toleranciaMs,
  };
}

/** De donde salio el instante que se le atribuyo a la operacion. */
export type FuenteDelInstante = 'dispositivo' | 'corregido' | 'servidor';

export interface InstanteConfiable {
  readonly at: Date;
  readonly fuente: FuenteDelInstante;
  /** Cuanto se le sumo a la hora del dispositivo. 0 si no se corrigio. */
  readonly offsetAplicadoMs: number;
}

/**
 * Instante que se puede usar sin miedo para ordenar, clasificar e informar.
 *
 * La hora cruda del dispositivo NO se pisa en ninguna parte: se guarda tal cual
 * y esta funcion decide, al leer, cual instante corresponde mostrar. Esa
 * separacion es la que permite explicar despues por que el informe dice una
 * hora distinta a la que marcaba el telefono.
 *
 * Escalera de decision:
 *
 *   1. Sin hora del dispositivo    -> la del servidor.
 *   2. Sin medicion, o dentro de la tolerancia -> la del dispositivo tal cual.
 *      Sin medicion no se puede AFIRMAR que este mal; corregir a ciegas seria
 *      inventar evidencia.
 *   3. Reloj fuera de tolerancia   -> hora del dispositivo + offset medido.
 *   4. Si esa correccion cae DESPUES de que el servidor recibio, se usa la del
 *      servidor: un escaneo no puede haber ocurrido despues de llegar. Pasa
 *      cuando el guardia cambia la hora del telefono entre encolar y enviar.
 */
export function instanteConfiable(params: {
  deviceAt: Date | string | null | undefined;
  serverAt: Date | string;
  medicion: MedicionDeReloj | null;
}): InstanteConfiable {
  // El fallback al reloj del proceso es defensivo: serverAt siempre viene del
  // now() de PostgreSQL, que es la unica hora que este sistema considera cierta.
  const servidor = aFecha(params.serverAt) ?? new Date();
  const dispositivo = aFecha(params.deviceAt);

  if (!dispositivo) {
    return { at: servidor, fuente: 'servidor', offsetAplicadoMs: 0 };
  }
  if (!params.medicion || !params.medicion.desfasado) {
    return { at: dispositivo, fuente: 'dispositivo', offsetAplicadoMs: 0 };
  }

  const corregido = new Date(dispositivo.getTime() + params.medicion.offsetMs);
  if (corregido.getTime() > servidor.getTime()) {
    return { at: servidor, fuente: 'servidor', offsetAplicadoMs: 0 };
  }
  return {
    at: corregido,
    fuente: 'corregido',
    offsetAplicadoMs: params.medicion.offsetMs,
  };
}

/** Minutos de desfase, con signo, para mostrarle al guardia y al supervisor. */
export function minutosDeDesfase(medicion: MedicionDeReloj): number {
  return Math.round(medicion.offsetMs / 60_000);
}

/**
 * Aviso para el guardia. Se le habla de su telefono, no del protocolo: el
 * mensaje tiene que servirle a alguien que esta por salir a hacer una ronda.
 */
export function avisoDeReloj(medicion: MedicionDeReloj | null): string | null {
  if (!medicion || !medicion.desfasado) return null;
  const minutos = Math.abs(minutosDeDesfase(medicion));
  const sentido = medicion.offsetMs > 0 ? 'atrasado' : 'adelantado';
  return (
    `Tu teléfono está ${sentido} ${minutos} min respecto de la hora del servidor. ` +
    'Activa la hora automática antes de salir a terreno: mientras siga así, el sistema ' +
    'corrige la hora de tus marcas y las señala en el informe.'
  );
}
