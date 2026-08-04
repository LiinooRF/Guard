/**
 * Informes por sucursal (#87) — tipos y calculo puro.
 *
 * Aca no hay React ni fetch a proposito: es lo unico de este carril que se
 * puede probar con Jest sin levantar un navegador. Escalas, rangos, recortes de
 * texto y formatos viven aca; los componentes solo dibujan lo que esto devuelve.
 *
 * Las cuatro respuestas de `/api/stats/charts/*` estan tipadas tal como las
 * arma `stats-charts.service.ts`. Ojo con la mezcla de idiomas: el cuerpo usa
 * claves en ingles (`threshold`, `sites`) pero `range` viene con las claves de
 * `RangoDias`, que son en castellano (`desde`, `hasta`, `dias`). No es un
 * descuido mio: es lo que responde la API hoy.
 */

/* ------------------------------------------------------------------ */
/* Respuestas de la API                                                */
/* ------------------------------------------------------------------ */

export interface RangoApi {
  desde: string;
  hasta: string;
  dias: number;
}

export interface RecintoCumplimiento {
  siteId: string;
  siteName: string;
  branchName: string;
  patrols: number;
  completed: number;
  incomplete: number;
  expired: number;
  open: number;
  ratedPatrols: number;
  compliancePct: number | null;
  belowThreshold: boolean;
}

export interface CumplimientoPorRecinto {
  range: RangoApi;
  threshold: number;
  sites: RecintoCumplimiento[];
}

export type Granularidad = 'dia' | 'semana' | 'mes';

export interface PuntoEvolucion {
  /** El servidor lo manda como fecha; en JSON llega como texto ISO. */
  bucket: string;
  patrols: number;
  completed: number;
  sites: number;
  compliancePct: number | null;
}

export interface Evolucion {
  range: RangoApi;
  granularity: Granularidad;
  threshold: number;
  points: PuntoEvolucion[];
}

export interface PuntoOmitido {
  checkpointId: string;
  checkpointName: string;
  kind: string;
  siteName: string;
  branchName: string;
  expected: number;
  missed: number;
  missedPct: number;
}

export interface PuntosOmitidos {
  range: RangoApi;
  checkpoints: PuntoOmitido[];
}

export interface GuardiaRanking {
  guardId: string;
  guardName: string;
  patrols: number;
  ratedPatrols: number;
  compliancePct: number | null;
  belowThreshold: number;
}

export interface RankingGuardias {
  range: RangoApi;
  threshold: number;
  guards: GuardiaRanking[];
}

/* ------------------------------------------------------------------ */
/* Topes de rango                                                      */
/* ------------------------------------------------------------------ */

/**
 * Los topes que impone la API (`apps/api/src/stats/stats-range.ts`).
 *
 * Estan duplicados aca por una razon concreta: el panel tiene que IMPEDIR el
 * rango antes de pedirlo, no mostrar el 400 del servidor. Si algun dia se
 * mueven alla, hay que moverlos aca — el test los deja anotados.
 */
export const TOPE_DIAS = {
  cumplimiento: 731,
  evolucion: 731,
  ranking: 366,
  omitidos: 92,
} as const;

export type ClaveGrafica = keyof typeof TOPE_DIAS;

/** El tope mas ancho: mas alla de esto no hay grafica que responda. */
export const TOPE_MAXIMO = Math.max(...Object.values(TOPE_DIAS));

export const DIAS_POR_DEFECTO = 30;

/**
 * Por que cada grafica tiene el tope que tiene, en palabras del jefe de
 * operaciones y no del motor de base de datos.
 */
export const MOTIVO_TOPE: Record<ClaveGrafica, string> = {
  cumplimiento: 'El cumplimiento por recinto se puede consultar hasta dos años hacia atrás.',
  evolucion: 'La evolución se puede consultar hasta dos años hacia atrás.',
  ranking:
    'El ranking de guardias se calcula ronda por ronda con el umbral vigente, así que cubre hasta un año.',
  omitidos:
    'Los puntos omitidos se revisan escaneo por escaneo, que es el registro más pesado del sistema. Por eso cubren hasta tres meses.',
};

/** Nombre de cada grafica tal como se lee en pantalla. */
export const NOMBRE_GRAFICA: Record<ClaveGrafica, string> = {
  cumplimiento: 'Cumplimiento por recinto',
  evolucion: 'Evolución en el tiempo',
  ranking: 'Ranking de guardias',
  omitidos: 'Puntos más omitidos',
};

/**
 * Que graficas quedan fuera con un periodo de `dias`.
 *
 * Se usa dos veces y las dos importan: en el filtro, para avisar ANTES de
 * aplicar el periodo; y en el componente de servidor, para no llegar a pedir lo
 * que la API va a rechazar.
 */
export function graficasLimitadas(dias: number): ClaveGrafica[] {
  return (Object.keys(TOPE_DIAS) as ClaveGrafica[]).filter((clave) => dias > TOPE_DIAS[clave]);
}

const MS_POR_DIA = 86_400_000;
const FORMATO_DIA = /^\d{4}-\d{2}-\d{2}$/;

/* ------------------------------------------------------------------ */
/* Calendario                                                          */
/* ------------------------------------------------------------------ */

/** `true` si el texto es un dia calendario valido en formato YYYY-MM-DD. */
export function esDia(valor: string | undefined | null): valor is string {
  if (typeof valor !== 'string' || !FORMATO_DIA.test(valor)) return false;
  const fecha = new Date(`${valor}T00:00:00.000Z`);
  return !Number.isNaN(fecha.getTime()) && fecha.toISOString().slice(0, 10) === valor;
}

/** El dia de hoy en UTC. Mismo criterio que usa la API cuando no le mandan `to`. */
export function hoyUtc(ahora: number = Date.now()): string {
  return new Date(ahora - (ahora % MS_POR_DIA)).toISOString().slice(0, 10);
}

export function sumarDias(dia: string, cantidad: number): string {
  const base = new Date(`${dia}T00:00:00.000Z`).getTime();
  return new Date(base + cantidad * MS_POR_DIA).toISOString().slice(0, 10);
}

/** Dias del rango con los dos extremos incluidos, igual que la API. */
export function diasEntre(desde: string, hasta: string): number {
  const inicio = new Date(`${desde}T00:00:00.000Z`).getTime();
  const fin = new Date(`${hasta}T00:00:00.000Z`).getTime();
  return Math.round((fin - inicio) / MS_POR_DIA) + 1;
}

export interface RangoPanel {
  readonly desde: string;
  readonly hasta: string;
  readonly dias: number;
  /** `true` si lo que venia en la URL no servia y hubo que corregirlo. */
  readonly ajustado: boolean;
}

/**
 * Resuelve el rango que el panel va a pedir, a partir de lo que trae la URL.
 *
 * Nunca lanza: una URL editada a mano —o un enlace viejo— tiene que abrir el
 * panel igual, con el ultimo mes y un aviso, y no con una pantalla de error.
 * La validacion dura sigue estando en el servidor; esto es para que el usuario
 * no la vea nunca.
 */
export function resolverRangoPanel(
  desde: string | undefined,
  hasta: string | undefined,
  hoy: string,
): RangoPanel {
  let ajustado = false;

  let fin = hoy;
  if (esDia(hasta)) {
    // Un `hasta` futuro no es un error del usuario: la API tampoco devolveria
    // nada mas alla de hoy. Se recorta en silencio a hoy.
    fin = hasta > hoy ? hoy : hasta;
  } else if (hasta !== undefined) {
    ajustado = true;
  }

  let inicio = sumarDias(fin, -(DIAS_POR_DEFECTO - 1));
  if (esDia(desde)) {
    if (desde > fin) ajustado = true;
    else inicio = desde;
  } else if (desde !== undefined) {
    ajustado = true;
  }

  let dias = diasEntre(inicio, fin);
  if (dias > TOPE_MAXIMO) {
    inicio = sumarDias(fin, -(TOPE_MAXIMO - 1));
    dias = TOPE_MAXIMO;
    ajustado = true;
  }

  return { desde: inicio, hasta: fin, dias, ajustado };
}

/** Rangos rapidos del selector. `dias` incluye el dia de hoy. */
export const RANGOS_RAPIDOS: ReadonlyArray<{ clave: string; etiqueta: string; dias: number }> = [
  { clave: '7', etiqueta: 'Últimos 7 días', dias: 7 },
  { clave: '30', etiqueta: 'Últimos 30 días', dias: 30 },
  { clave: '90', etiqueta: 'Últimos 90 días', dias: 90 },
  { clave: '180', etiqueta: 'Últimos 6 meses', dias: 180 },
  { clave: '365', etiqueta: 'Último año', dias: 365 },
  { clave: '731', etiqueta: 'Últimos 2 años', dias: 731 },
];

/**
 * Agrupacion sugerida segun el largo del periodo.
 *
 * Dos años por dia son 731 puntos en una linea de 700 pixeles: no es una serie,
 * es una mancha. La sugerencia se puede cambiar a mano en el selector.
 */
export function granularidadSugerida(dias: number): Granularidad {
  if (dias <= 45) return 'dia';
  if (dias <= 240) return 'semana';
  return 'mes';
}

/**
 * El `bucket` de la serie llega como instante ISO porque PostgreSQL entrega
 * `date` y el driver lo convierte a `Date` en la zona del proceso. Redondear al
 * mediodia mas cercano devuelve el dia correcto tanto si el servidor corre en
 * UTC como si corre en Santiago o en Madrid.
 */
export function normalizarDia(valor: string): string {
  if (FORMATO_DIA.test(valor)) return valor;
  const ms = Date.parse(valor);
  if (Number.isNaN(ms)) return valor.slice(0, 10);
  return new Date(Math.round(ms / MS_POR_DIA) * MS_POR_DIA).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* Escalas y geometria                                                 */
/* ------------------------------------------------------------------ */

const PASOS_AGRADABLES = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10] as const;

/**
 * Techo "redondo" para el eje de una grafica de conteos.
 *
 * Que la barra mas larga toque el borde derecho deja la cifra sin donde
 * escribirse y hace ver todo al maximo. Se sube al siguiente numero limpio.
 */
export function escalaAgradable(maximo: number): number {
  if (!Number.isFinite(maximo) || maximo <= 0) return 1;
  const magnitud = 10 ** Math.floor(Math.log10(maximo));
  const normalizado = maximo / magnitud;
  const paso = PASOS_AGRADABLES.find((candidato) => normalizado <= candidato) ?? 10;
  return Number((paso * magnitud).toPrecision(12));
}

/** Fraccion 0..1 de `valor` dentro de la escala, recortada a los extremos. */
export function fraccion(valor: number, escala: number): number {
  if (!Number.isFinite(valor) || !Number.isFinite(escala) || escala <= 0) return 0;
  return Math.min(1, Math.max(0, valor / escala));
}

/**
 * Donde va la cifra de una barra.
 *
 * Pasado el 82% del ancho, la cifra escrita afuera se sale de la tarjeta y
 * termina cortada. Ahi se escribe adentro, en blanco. Es la regla de "medir
 * antes de etiquetar" reducida a un umbral, porque en SVG servidor no hay
 * forma de medir texto.
 */
export function posicionEtiqueta(fraccionBarra: number): 'dentro' | 'fuera' {
  return fraccionBarra > 0.82 ? 'dentro' : 'fuera';
}

/** Ancla del texto de una referencia vertical para que no se salga del marco. */
export function anclaTexto(porcentaje: number): 'start' | 'middle' | 'end' {
  if (porcentaje <= 8) return 'start';
  if (porcentaje >= 88) return 'end';
  return 'middle';
}

/**
 * Que indices de una serie llevan etiqueta en el eje horizontal.
 *
 * Con 90 puntos, 90 fechas se pisan y no se lee ninguna. Se reparten `maximo`
 * etiquetas incluyendo siempre el primero y el ultimo.
 */
export function indicesEtiquetados(total: number, maximo = 6): number[] {
  if (total <= 0) return [];
  if (total <= maximo) return Array.from({ length: total }, (_, indice) => indice);
  const paso = (total - 1) / (maximo - 1);
  const indices = new Set<number>();
  for (let posicion = 0; posicion < maximo; posicion += 1) {
    indices.add(Math.round(posicion * paso));
  }
  return [...indices].sort((a, b) => a - b);
}

/** Posicion horizontal en porcentaje del punto `indice` de una serie de `total`. */
export function posicionSerie(indice: number, total: number): number {
  if (total <= 1) return 50;
  return (indice / (total - 1)) * 100;
}

/* ------------------------------------------------------------------ */
/* Textos                                                              */
/* ------------------------------------------------------------------ */

/** Recorta sin cortar a mitad de palabra cuando se puede. */
export function truncar(texto: string, maximo: number): string {
  if (texto.length <= maximo) return texto;
  const cortado = texto.slice(0, maximo - 1);
  const espacio = cortado.lastIndexOf(' ');
  return `${(espacio > maximo * 0.6 ? cortado.slice(0, espacio) : cortado).trimEnd()}…`;
}

export function formatearPorcentaje(valor: number | null): string {
  if (valor === null || !Number.isFinite(valor)) return 'Sin dato';
  return `${new Intl.NumberFormat('es-CL', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(valor)}%`;
}

export function formatearEntero(valor: number): string {
  return new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(valor);
}

/** "3 rondas" / "1 ronda". El plural mal puesto lo nota cualquiera. */
export function plural(cantidad: number, singular: string, pluralizado: string): string {
  return `${formatearEntero(cantidad)} ${cantidad === 1 ? singular : pluralizado}`;
}

const MESES = [
  'ene',
  'feb',
  'mar',
  'abr',
  'may',
  'jun',
  'jul',
  'ago',
  'sep',
  'oct',
  'nov',
  'dic',
] as const;

/**
 * Etiqueta corta de un punto de la serie. Se arma a mano y no con `Intl` para
 * que el texto sea identico en el servidor y en el navegador: un desajuste de
 * locale entre ambos rompe la hidratacion de React.
 */
export function etiquetaBucket(dia: string, granularidad: Granularidad): string {
  const partes = dia.split('-');
  const anio = partes[0] ?? '';
  const mes = MESES[Number(partes[1] ?? '1') - 1] ?? '';
  const numeroDia = partes[2] ?? '';
  if (granularidad === 'mes') return `${mes} ${anio}`;
  if (granularidad === 'semana') return `sem. ${numeroDia} ${mes}`;
  return `${numeroDia} ${mes}`;
}

/** Fecha larga para los encabezados: "3 de agosto de 2026". */
export function etiquetaDiaLargo(dia: string): string {
  const partes = dia.split('-');
  const nombres = [
    'enero',
    'febrero',
    'marzo',
    'abril',
    'mayo',
    'junio',
    'julio',
    'agosto',
    'septiembre',
    'octubre',
    'noviembre',
    'diciembre',
  ];
  const mes = nombres[Number(partes[1] ?? '1') - 1] ?? '';
  return `${Number(partes[2] ?? '1')} de ${mes} de ${partes[0] ?? ''}`;
}

export function etiquetaRango(rango: { desde: string; hasta: string }): string {
  return `del ${etiquetaDiaLargo(rango.desde)} al ${etiquetaDiaLargo(rango.hasta)}`;
}

/* ------------------------------------------------------------------ */
/* Resumen de cabecera                                                 */
/* ------------------------------------------------------------------ */

export interface ResumenCumplimiento {
  /** Promedio ponderado por rondas evaluadas, no promedio de promedios. */
  promedio: number | null;
  rondas: number;
  completadas: number;
  recintos: number;
  bajoUmbral: number;
  /** El recinto con peor cumplimiento del periodo, si alguno tiene dato. */
  peor: RecintoCumplimiento | null;
}

/**
 * Cifras de cabecera a partir del cumplimiento por recinto.
 *
 * El promedio se pondera por `ratedPatrols` (las rondas que efectivamente
 * tienen cumplimiento calculado). Promediar los promedios de cada recinto haria
 * que una bodega con dos rondas pesara lo mismo que un mall con doscientas.
 */
export function resumirCumplimiento(recintos: RecintoCumplimiento[]): ResumenCumplimiento {
  let sumaPonderada = 0;
  let evaluadas = 0;
  let rondas = 0;
  let completadas = 0;
  let bajoUmbral = 0;
  let peor: RecintoCumplimiento | null = null;

  for (const recinto of recintos) {
    rondas += recinto.patrols;
    completadas += recinto.completed;
    if (recinto.belowThreshold) bajoUmbral += 1;
    if (recinto.compliancePct !== null && recinto.ratedPatrols > 0) {
      sumaPonderada += recinto.compliancePct * recinto.ratedPatrols;
      evaluadas += recinto.ratedPatrols;
      if (peor === null || recinto.compliancePct < (peor.compliancePct ?? Infinity)) peor = recinto;
    }
  }

  return {
    promedio: evaluadas > 0 ? Math.round((sumaPonderada / evaluadas) * 10) / 10 : null,
    rondas,
    completadas,
    recintos: recintos.length,
    bajoUmbral,
    peor,
  };
}

/* ------------------------------------------------------------------ */
/* Opciones de filtro                                                  */
/* ------------------------------------------------------------------ */

export interface OpcionRecinto {
  id: string;
  nombre: string;
  sucursal: string;
}

/**
 * Recintos para el selector, sacados de la propia respuesta de cumplimiento.
 *
 * No existe hoy un `GET /supervisor/sites`, y `GET /admin/sites` es solo del
 * ADMIN. La respuesta de `compliance-by-site` ya viene acotada al alcance de
 * quien pregunta —el SUPERVISOR solo ve los suyos—, asi que sirve de catalogo
 * sin agregar una llamada ni arriesgar un 403.
 *
 * Efecto lateral asumido: un recinto sin ninguna ronda en el periodo no aparece
 * en la lista. Es coherente con lo que se esta mirando.
 */
export function opcionesDeRecinto(recintos: RecintoCumplimiento[]): OpcionRecinto[] {
  return [...recintos]
    .map((recinto) => ({
      id: recinto.siteId,
      nombre: recinto.siteName,
      sucursal: recinto.branchName,
    }))
    .sort((a, b) =>
      `${a.sucursal} ${a.nombre}`.localeCompare(`${b.sucursal} ${b.nombre}`, 'es'),
    );
}

/** Sucursales presentes, para comparar "por sucursal" que es como lo pidio el cliente. */
export function opcionesDeSucursal(recintos: RecintoCumplimiento[]): string[] {
  return [...new Set(recintos.map((recinto) => recinto.branchName))].sort((a, b) =>
    a.localeCompare(b, 'es'),
  );
}

export interface SucursalAgrupada {
  sucursal: string;
  recintos: number;
  rondas: number;
  promedio: number | null;
  bajoUmbral: number;
}

/**
 * Agrupa los recintos por sucursal. Es la vista que pidio el cliente en el
 * issue: comparar sucursales en una sola pantalla, no recinto por recinto.
 */
export function agruparPorSucursal(recintos: RecintoCumplimiento[]): SucursalAgrupada[] {
  const acumulado = new Map<
    string,
    { recintos: number; rondas: number; suma: number; evaluadas: number; bajoUmbral: number }
  >();

  for (const recinto of recintos) {
    const actual = acumulado.get(recinto.branchName) ?? {
      recintos: 0,
      rondas: 0,
      suma: 0,
      evaluadas: 0,
      bajoUmbral: 0,
    };
    actual.recintos += 1;
    actual.rondas += recinto.patrols;
    if (recinto.belowThreshold) actual.bajoUmbral += 1;
    if (recinto.compliancePct !== null && recinto.ratedPatrols > 0) {
      actual.suma += recinto.compliancePct * recinto.ratedPatrols;
      actual.evaluadas += recinto.ratedPatrols;
    }
    acumulado.set(recinto.branchName, actual);
  }

  return [...acumulado.entries()]
    .map(([sucursal, datos]) => ({
      sucursal,
      recintos: datos.recintos,
      rondas: datos.rondas,
      promedio: datos.evaluadas > 0 ? Math.round((datos.suma / datos.evaluadas) * 10) / 10 : null,
      bajoUmbral: datos.bajoUmbral,
    }))
    // Peor primero: al panel se entra a buscar el problema, no a felicitarse.
    .sort((a, b) => (a.promedio ?? 101) - (b.promedio ?? 101) || a.sucursal.localeCompare(b.sucursal, 'es'));
}
