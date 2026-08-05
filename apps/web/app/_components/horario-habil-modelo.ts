/**
 * Logica pura del horario habil por recinto (#68), sin React.
 *
 * Espeja EXACTAMENTE el predicado de EvidenceService.isWithinBusinessHours()
 * (apps/api/src/evidence/evidence.service.ts). Si aquel cambia, esto queda
 * mintiendo. Las reglas que espeja, una por una:
 *
 *  1. weekday 0=domingo .. 6=sabado (igual que la migracion y businessHoursSchema).
 *  2. Un tramo con opens_at < closes_at cubre [opens, closes) del MISMO dia.
 *  3. Un tramo con opens_at > closes_at CRUZA MEDIANOCHE: cubre [opens, 24:00)
 *     de su dia y ademas [00:00, closes) del dia SIGUIENTE. Por eso el SQL mira
 *     tambien la fila del dia ANTERIOR — la madrugada del sabado pertenece a la
 *     fila del viernes, no a la del sabado.
 *  4. opens_at = closes_at esta prohibido (CHECK en la tabla + 400 de la API).
 *  5. Un feriado apaga el dia CALENDARIO local completo, y gana sobre cualquier
 *     tramo, incluido el nocturno que venia del dia anterior.
 *  6. Recinto sin ninguna fila de horario y sin feriado ese dia: aca NO se
 *     decide. Lo decide la regla businessHoursDefaultOpen del tenant, que no es
 *     un interruptor de "abierto/cerrado" sino "que asumir MIENTRAS no hay
 *     horario cargado". Por eso el veredicto local es 'sin-horario' y no un
 *     true o false inventado.
 *
 * Todo lo que se calcula aca esta en hora LOCAL DEL RECINTO, en texto naive
 * ("YYYY-MM-DD" + "HH:MM"). El navegador nunca convierte husos: sumar dias se
 * hace sobre la fecha sin zona, y la conversion a instante la hace Postgres.
 */

export interface TramoHorario {
  /** 0 = domingo ... 6 = sabado */
  weekday: number;
  /** "HH:MM" en la zona horaria DEL RECINTO */
  opensAt: string;
  closesAt: string;
}

export interface FeriadoRecinto {
  /** "YYYY-MM-DD" en la zona horaria DEL RECINTO */
  date: string;
  name: string | null;
}

export const DIAS = [
  'Domingo',
  'Lunes',
  'Martes',
  'Miércoles',
  'Jueves',
  'Viernes',
  'Sábado',
] as const;

/** Tope superior de un dia, para representar "hasta la medianoche". */
export const FIN_DEL_DIA = '24:00';

export function nombreDia(weekday: number): string {
  return DIAS[normalizarDia(weekday)] ?? '';
}

function normalizarDia(weekday: number): number {
  return ((Math.trunc(weekday) % 7) + 7) % 7;
}

/** El dia cuya fila nocturna puede derramarse sobre este dia. */
export function diaAnterior(weekday: number): number {
  return normalizarDia(weekday + 6);
}

/** opens > closes: el tramo cruza medianoche y termina al dia siguiente. */
export function cruzaMedianoche(tramo: TramoHorario): boolean {
  return tramo.opensAt > tramo.closesAt;
}

/**
 * Lo que el servidor rechazaria con 400 (y la tabla con su CHECK). Se valida
 * aca solo para avisar antes de mandar: el control es del servidor.
 */
export function errorDelTramo(tramo: TramoHorario): string | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(tramo.opensAt)) return 'La hora de apertura no es válida.';
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(tramo.closesAt)) return 'La hora de cierre no es válida.';
  if (tramo.opensAt === tramo.closesAt) {
    return 'La apertura y el cierre no pueden ser iguales. Para dejar el día cerrado, desmarca el día.';
  }
  return null;
}

/** Todos los errores del formulario, indexados por día. Vacío = se puede guardar. */
export function erroresDeSemana(tramos: readonly TramoHorario[]): Map<number, string> {
  const errores = new Map<number, string>();
  for (const tramo of tramos) {
    const error = errorDelTramo(tramo);
    if (error) errores.set(tramo.weekday, error);
  }
  return errores;
}

export interface FranjaCobertura {
  /** "HH:MM" inclusive */
  desde: string;
  /** "HH:MM" exclusivo; puede ser "24:00" */
  hasta: string;
  /** Dia de la semana de la FILA que genera la franja. */
  origen: number;
  /** true = la franja viene del tramo nocturno del dia anterior. */
  heredada: boolean;
}

/**
 * Las franjas que hacen habil a un dia de la semana, con el dia del que sale
 * cada una. Es la traduccion visible del OR de dos ramas que hace el SQL.
 */
export function coberturaDelDia(
  weekday: number,
  tramos: readonly TramoHorario[],
): FranjaCobertura[] {
  const dia = normalizarDia(weekday);
  const previo = normalizarDia(dia + 6);
  const franjas: FranjaCobertura[] = [];

  const anterior = tramos.find((tramo) => normalizarDia(tramo.weekday) === previo);
  if (anterior && !errorDelTramo(anterior) && cruzaMedianoche(anterior)) {
    // La madrugada pertenece a la fila del dia ANTERIOR.
    if (anterior.closesAt > '00:00') {
      franjas.push({ desde: '00:00', hasta: anterior.closesAt, origen: previo, heredada: true });
    }
  }

  const propio = tramos.find((tramo) => normalizarDia(tramo.weekday) === dia);
  if (propio && !errorDelTramo(propio)) {
    const hasta = cruzaMedianoche(propio) ? FIN_DEL_DIA : propio.closesAt;
    if (propio.opensAt < hasta) {
      franjas.push({ desde: propio.opensAt, hasta, origen: dia, heredada: false });
    }
  }

  return franjas.sort((a, b) => a.desde.localeCompare(b.desde));
}

/** "22:00 → 06:00 del sábado" / "09:00 → 18:00". Texto para el editor. */
export function descripcionTramo(tramo: TramoHorario): string {
  if (!cruzaMedianoche(tramo)) return `${tramo.opensAt} → ${tramo.closesAt}`;
  const siguiente = nombreDia(normalizarDia(tramo.weekday + 1)).toLocaleLowerCase('es');
  return `${tramo.opensAt} → ${tramo.closesAt} del ${siguiente}`;
}

export function descripcionFranja(franja: FranjaCobertura): string {
  const rango = `${franja.desde}–${franja.hasta}`;
  if (!franja.heredada) return rango;
  return `${rango} (viene del ${nombreDia(franja.origen).toLocaleLowerCase('es')})`;
}

export type VeredictoLocal = 'habil' | 'no-habil' | 'sin-horario';

export interface EvaluacionLocal {
  veredicto: VeredictoLocal;
  /** Franja que cubre el instante, si alguna. */
  franja: FranjaCobertura | null;
  cobertura: FranjaCobertura[];
  feriado: FeriadoRecinto | null;
  weekday: number | null;
  motivo: string;
}

/**
 * Vista previa de lo que el admin esta editando, ANTES de guardar.
 *
 * No es la autoridad: la autoridad es GET /admin/sites/:id/business-hours/check,
 * que corre el mismo metodo que usa el terreno. Esto existe para que el admin
 * vea el efecto de un cambio sin guardarlo, y esta escrito para no poder
 * contradecir al servidor (ver la lista de reglas espejadas arriba).
 */
export function evaluarHorarioLocal(args: {
  tramos: readonly TramoHorario[];
  feriados: readonly FeriadoRecinto[];
  /** "YYYY-MM-DD" local del recinto */
  fecha: string;
  /** "HH:MM" local del recinto */
  hora: string;
}): EvaluacionLocal {
  const { tramos, feriados, fecha, hora } = args;
  const weekday = diaDeLaSemana(fecha);

  if (weekday === null) {
    return {
      veredicto: 'sin-horario',
      franja: null,
      cobertura: [],
      feriado: null,
      weekday: null,
      motivo: 'Esa fecha no es válida.',
    };
  }

  const cobertura = coberturaDelDia(weekday, tramos);
  const feriado = feriados.find((item) => item.date === fecha) ?? null;

  // Espeja has_hours del SQL: un feriado cargado ya es configuracion suficiente
  // aunque el recinto no tenga ni una fila de horario semanal.
  if (!tramos.length && !feriado) {
    return {
      veredicto: 'sin-horario',
      franja: null,
      cobertura,
      feriado: null,
      weekday,
      motivo:
        'Este recinto no tiene horario cargado. Mientras eso siga así, lo decide la regla «Recinto sin horario cargado cuenta como abierto», que se configura en Reglas de operación, no acá.',
    };
  }

  if (feriado) {
    return {
      veredicto: 'no-habil',
      franja: null,
      cobertura,
      feriado,
      weekday,
      motivo: `${fecha} está marcado como feriado del recinto${feriado.name ? ` (${feriado.name})` : ''}. Un feriado apaga el día completo, incluida la madrugada que venía del tramo nocturno del día anterior.`,
    };
  }

  const franja = cobertura.find((item) => hora >= item.desde && hora < item.hasta) ?? null;

  if (!franja) {
    return {
      veredicto: 'no-habil',
      franja: null,
      cobertura,
      feriado: null,
      weekday,
      motivo: cobertura.length
        ? `A las ${hora} el ${nombreDia(weekday).toLocaleLowerCase('es')} no cae en ningún tramo hábil.`
        : `El ${nombreDia(weekday).toLocaleLowerCase('es')} no tiene tramo hábil: el día entero queda fuera de horario.`,
    };
  }

  return {
    veredicto: 'habil',
    franja,
    cobertura,
    feriado: null,
    weekday,
    motivo: franja.heredada
      ? `Las ${hora} caen en el tramo nocturno del ${nombreDia(franja.origen).toLocaleLowerCase('es')}, que termina a las ${franja.hasta}.`
      : `Las ${hora} caen en el tramo ${franja.desde}–${franja.hasta} del ${nombreDia(franja.origen).toLocaleLowerCase('es')}.`,
  };
}

/**
 * Dia de la semana de una fecha naive, sin que el huso del navegador opine.
 * Se ancla en UTC a proposito: la fecha es texto del recinto, no un instante.
 */
export function diaDeLaSemana(fecha: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return null;
  const ms = Date.parse(`${fecha}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  const dia = new Date(ms);
  // Date.parse acepta 2026-02-30 en algunos motores corriendola a marzo: si la
  // fecha se movio, no era una fecha real.
  if (dia.toISOString().slice(0, 10) !== fecha) return null;
  return dia.getUTCDay();
}

/**
 * Suma dias a la fecha LOCAL del recinto, en texto y sin zona.
 *
 * Esta es la unica aritmetica de fechas del panel, y va antes de cualquier
 * conversion: quien convierte a instante es Postgres, con la zona del recinto.
 * Hacerlo al reves (mover un instante y despues convertir) se corre una hora en
 * cada cambio de horario de verano.
 */
export function sumarDias(fecha: string, dias: number): string {
  const ms = Date.parse(`${fecha}T00:00:00Z`);
  if (Number.isNaN(ms)) return fecha;
  const movida = new Date(ms);
  movida.setUTCDate(movida.getUTCDate() + Math.trunc(dias));
  return movida.toISOString().slice(0, 10);
}

/**
 * La proxima fecha que caiga en ese dia de la semana, contando hoy. Sirve para
 * el atajo "prueba un sábado de madrugada" sin escribir una fecha a mano.
 */
export function proximoDiaDeSemana(fecha: string, weekday: number): string {
  const actual = diaDeLaSemana(fecha);
  if (actual === null) return fecha;
  return sumarDias(fecha, normalizarDia(weekday - actual));
}

/** Cuantos dias de la semana quedan totalmente fuera de horario. */
export function diasSinCobertura(tramos: readonly TramoHorario[]): number[] {
  return DIAS.map((_, weekday) => weekday).filter(
    (weekday) => coberturaDelDia(weekday, tramos).length === 0,
  );
}
