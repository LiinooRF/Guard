import type { ScanAnomaly } from '@sentrycore/shared';

import {
  decimal,
  entero,
  fecha,
  fechaHora,
  texto,
  VACIO,
  type Celda,
  type FilaExcel,
  type HojaExcel,
} from './excel-xlsx-writer';
import { CRITICIDADES, etiquetaAnomalia } from './patrol-report.model';
import { ESTADOS_RONDA } from './pdf-primitivas';

/**
 * Composicion del libro Excel de informes (#136).
 *
 * Aca no hay SQL ni Nest: entran filas tal como salen del driver y salen hojas.
 * Es la misma separacion que ya tiene el informe de ronda (model / renderer /
 * service) y sirve para lo mismo: probar el contenido sin base de datos.
 *
 * El Excel NO reemplaza al PDF. El PDF es el documento que se le manda al
 * cliente final —con marca, firma visual y anexo fotografico—; esto es la
 * planilla para que el administrador haga sus propios cruces. Por eso lleva los
 * identificadores (que en el PDF estorban) y no lleva imagenes.
 *
 * Las horas ya vienen resueltas EN LA ZONA DEL RECINTO desde PostgreSQL, en
 * texto sin zona: el numero de serie de Excel no tiene zona horaria, y volver a
 * convertir aca meteria la zona del servidor en el medio.
 */

// ------------------------------------------------------------------- filas

/** Columnas verificadas contra 1722524400000-CreateDemoDomain y 1724252400000-CreateShifts. */
export interface RondaExcelRow {
  readonly id: string;
  /** Dia local del recinto, 'YYYY-MM-DD'. */
  readonly fecha_local: string | null;
  readonly inicio_programado_local: string | null;
  readonly fin_programado_local: string | null;
  readonly inicio_real_local: string | null;
  readonly cierre_local: string | null;
  readonly site_name: string;
  readonly branch_name: string;
  readonly timezone: string;
  readonly route_name: string;
  readonly guard_name: string;
  readonly status: string;
  /** numeric(5,2): el driver de postgres lo entrega como string. */
  readonly compliance_pct: string | null;
  readonly is_voluntary: boolean;
  readonly puntos_esperados: number | string;
  /** count() es bigint: llega como string. */
  readonly puntos_marcados: string | number;
  readonly novedades: string | number;
}

/** Columnas verificadas contra 1723734000000-CreatePatrolScans y 1725462020000. */
export interface EscaneoExcelRow {
  readonly id: string;
  readonly patrol_id: string;
  readonly registrado_local: string | null;
  readonly dispositivo_local: string | null;
  readonly site_name: string;
  readonly branch_name: string;
  readonly timezone: string;
  readonly checkpoint_name: string;
  readonly kind: string;
  readonly method: string;
  readonly guard_name: string;
  readonly fotos: string | number;
  readonly anomalies: unknown;
  /** bigint. NULL = hora del dispositivo utilizable, NO desfase cero. */
  readonly clock_offset_ms: string | number | null;
}

/** Columnas verificadas contra 1723820400000-CreateFieldEvents. */
export interface NovedadExcelRow {
  readonly id: string;
  readonly registrado_local: string | null;
  readonly dispositivo_local: string | null;
  readonly site_name: string;
  readonly branch_name: string;
  readonly timezone: string;
  readonly criticality: string;
  readonly text: string | null;
  readonly guard_name: string;
  readonly patrol_id: string | null;
  readonly corrects_event_id: string | null;
  readonly fotos: string | number;
}

export interface FiltrosExportacion {
  /** Nombre del recinto, o null cuando no se filtro por recinto. */
  readonly recinto: string | null;
  readonly sucursal: string | null;
  /** Nombre del guardia si aparece en los datos; si no, su identificador. */
  readonly guardia: string | null;
}

export interface DatosExportacion {
  readonly empresa: string;
  /** Dias calendario incluidos, ambos extremos, 'YYYY-MM-DD'. */
  readonly desde: string;
  readonly hasta: string;
  readonly filtros: FiltrosExportacion;
  /** Momento de generacion en hora local de `zonaReferencia`, sin zona. */
  readonly generadoEnLocal: string;
  readonly zonaReferencia: string;
  readonly rondas: readonly RondaExcelRow[];
  readonly escaneos: readonly EscaneoExcelRow[];
  readonly novedades: readonly NovedadExcelRow[];
  /** Tope de filas por hoja que rige (excelExportMaxRows). */
  readonly tope: number;
  /** Hojas que llegaron al tope y quedaron cortadas. */
  readonly truncadas: readonly string[];
}

// ----------------------------------------------------------------- etiquetas

export const HOJA_RESUMEN = 'Resumen';
export const HOJA_RONDAS = 'Rondas';
export const HOJA_ESCANEOS = 'Escaneos';
export const HOJA_NOVEDADES = 'Novedades';

const TIPOS_PUNTO: Record<string, string> = {
  normal: 'Normal',
  acceso_critico: 'Acceso crítico',
};

const METODOS: Record<string, string> = {
  nfc: 'NFC',
  qr: 'QR',
};

const SIN_FILTRO = 'Todos';

function siNo(valor: boolean): string {
  return valor ? 'Sí' : 'No';
}

/**
 * Las marcas de anomalia se muestran separadas por coma y en su texto legible.
 * Se dejan en una sola columna a proposito: son pocas y una columna por marca
 * convertiria la planilla en una matriz que nadie filtra.
 */
export function textoAnomalias(anomalies: unknown): string {
  if (!Array.isArray(anomalies)) return '';
  return anomalies
    .filter((marca): marca is string => typeof marca === 'string')
    .map((marca) => etiquetaAnomalia(marca as ScanAnomaly))
    .join(', ');
}

/**
 * Desfase del reloj del telefono, en minutos.
 *
 * NULL en la base significa "hora del dispositivo utilizable" (medida y dentro
 * de tolerancia, o nunca medida), NO desfase cero. Por eso la celda queda
 * VACIA: escribir 0 afirmaria una medicion que no existe.
 */
export function desfaseEnMinutos(clockOffsetMs: string | number | null): Celda {
  if (clockOffsetMs === null || clockOffsetMs === '') return VACIO;
  const ms = typeof clockOffsetMs === 'number' ? clockOffsetMs : Number(clockOffsetMs);
  if (!Number.isFinite(ms)) return VACIO;
  // Un decimal, que es lo que muestra el formato de la columna.
  return decimal(Math.round(ms / 6_000) / 10);
}

// -------------------------------------------------------------------- hojas

export function construirLibroExcel(datos: DatosExportacion): HojaExcel[] {
  return [
    hojaResumen(datos),
    hojaRondas(datos.rondas),
    hojaEscaneos(datos.escaneos),
    hojaNovedades(datos.novedades),
  ];
}

/**
 * Portada: que se exporto, con que filtros y en que zona horaria.
 *
 * No es decoracion. Una planilla sin el periodo ni los filtros escritos es
 * indefendible tres meses despues, cuando el jefe de operaciones tiene que
 * explicar de donde salio ese numero.
 */
function hojaResumen(datos: DatosExportacion): HojaExcel {
  const filas: FilaExcel[] = [
    [texto('Empresa'), texto(datos.empresa)],
    [texto('Contenido'), texto('Rondas, escaneos y novedades del periodo')],
    [texto('Desde (inclusive)'), fecha(datos.desde)],
    [texto('Hasta (inclusive)'), fecha(datos.hasta)],
    [texto('Zona horaria de referencia'), texto(datos.zonaReferencia)],
    [texto('Generado el'), fechaHora(datos.generadoEnLocal)],
    [texto('Recinto'), texto(datos.filtros.recinto ?? SIN_FILTRO)],
    [texto('Sucursal'), texto(datos.filtros.sucursal ?? SIN_FILTRO)],
    [texto('Guardia'), texto(datos.filtros.guardia ?? SIN_FILTRO)],
    [],
    [texto('Rondas exportadas'), entero(datos.rondas.length)],
    [texto('Escaneos exportados'), entero(datos.escaneos.length)],
    [texto('Novedades exportadas'), entero(datos.novedades.length)],
    [texto('Tope de filas por hoja'), entero(datos.tope)],
    [],
    [
      texto('Horas'),
      texto(
        'Cada fila muestra la hora del recinto al que pertenece; la columna ' +
          '«Zona horaria» de cada hoja lo indica.',
      ),
    ],
    [
      texto('Ubicación'),
      texto(
        'Esta planilla no incluye coordenadas de los trabajadores. Las ' +
          'desviaciones de ubicación se informan como marcas de anomalía.',
      ),
    ],
  ];

  if (datos.truncadas.length > 0) {
    filas.push([]);
    filas.push([
      texto('ATENCIÓN'),
      texto(
        `La exportación llegó al tope de ${datos.tope} filas en: ` +
          `${datos.truncadas.join(', ')}. La planilla está incompleta: acota el ` +
          'periodo o filtra por recinto.',
      ),
    ]);
    // Cada hoja se corta por separado y con su propio orden. Si la que se cortó
    // es Rondas, las otras dos conservan filas cuyo «Ronda (ID)» ya no está en
    // la hoja Rondas y el BUSCARV devuelve #N/D. Decirlo importa: sin este
    // aviso, un #N/D se lee como dato faltante y no como corte.
    if (datos.truncadas.includes(HOJA_RONDAS)) {
      filas.push([
        texto('ATENCIÓN'),
        texto(
          `La hoja ${HOJA_RONDAS} quedó cortada, así que el cruce entre hojas no es ` +
            `confiable: identificadores de la columna «Ronda (ID)» de ${HOJA_ESCANEOS} y ` +
            `${HOJA_NOVEDADES} pueden no aparecer en ${HOJA_RONDAS}. Un BUSCARV que ` +
            'devuelve #N/D acá significa corte, no dato faltante.',
        ),
      ]);
    }
  }

  return {
    nombre: HOJA_RESUMEN,
    columnas: [
      { titulo: 'Campo', ancho: 28 },
      { titulo: 'Valor', ancho: 80 },
    ],
    filas,
    autofiltro: false,
  };
}

function hojaRondas(rondas: readonly RondaExcelRow[]): HojaExcel {
  return {
    nombre: HOJA_RONDAS,
    columnas: [
      { titulo: 'Ronda (ID)', ancho: 38 },
      { titulo: 'Fecha', ancho: 12 },
      { titulo: 'Inicio programado', ancho: 18 },
      { titulo: 'Fin programado', ancho: 18 },
      { titulo: 'Inicio real', ancho: 18 },
      { titulo: 'Cierre', ancho: 18 },
      { titulo: 'Recinto', ancho: 26 },
      { titulo: 'Sucursal', ancho: 22 },
      { titulo: 'Zona horaria', ancho: 18 },
      { titulo: 'Ruta', ancho: 26 },
      { titulo: 'Guardia', ancho: 26 },
      { titulo: 'Estado', ancho: 14 },
      { titulo: '% de cumplimiento', ancho: 16 },
      { titulo: 'Puntos esperados', ancho: 15 },
      { titulo: 'Puntos marcados', ancho: 15 },
      { titulo: 'Novedades', ancho: 11 },
      { titulo: 'Voluntaria', ancho: 11 },
    ],
    filas: rondas.map((ronda) => [
      texto(ronda.id),
      fecha(ronda.fecha_local),
      fechaHora(ronda.inicio_programado_local),
      fechaHora(ronda.fin_programado_local),
      fechaHora(ronda.inicio_real_local),
      fechaHora(ronda.cierre_local),
      texto(ronda.site_name),
      texto(ronda.branch_name),
      texto(ronda.timezone),
      texto(ronda.route_name),
      texto(ronda.guard_name),
      texto(ESTADOS_RONDA[ronda.status] ?? ronda.status),
      decimal(ronda.compliance_pct),
      entero(ronda.puntos_esperados),
      entero(ronda.puntos_marcados),
      entero(ronda.novedades),
      texto(siNo(ronda.is_voluntary)),
    ]),
  };
}

function hojaEscaneos(escaneos: readonly EscaneoExcelRow[]): HojaExcel {
  return {
    nombre: HOJA_ESCANEOS,
    columnas: [
      { titulo: 'Escaneo (ID)', ancho: 38 },
      { titulo: 'Ronda (ID)', ancho: 38 },
      { titulo: 'Registrado en el servidor', ancho: 20 },
      { titulo: 'Hora del teléfono', ancho: 20 },
      { titulo: 'Recinto', ancho: 26 },
      { titulo: 'Sucursal', ancho: 22 },
      { titulo: 'Zona horaria', ancho: 18 },
      { titulo: 'Punto de control', ancho: 28 },
      { titulo: 'Tipo de punto', ancho: 16 },
      { titulo: 'Método', ancho: 10 },
      { titulo: 'Guardia', ancho: 26 },
      { titulo: 'Fotos', ancho: 8 },
      { titulo: 'Marcas de anomalía', ancho: 34 },
      { titulo: 'Desfase de reloj (min)', ancho: 18 },
    ],
    filas: escaneos.map((escaneo) => [
      texto(escaneo.id),
      texto(escaneo.patrol_id),
      fechaHora(escaneo.registrado_local),
      fechaHora(escaneo.dispositivo_local),
      texto(escaneo.site_name),
      texto(escaneo.branch_name),
      texto(escaneo.timezone),
      texto(escaneo.checkpoint_name),
      texto(TIPOS_PUNTO[escaneo.kind] ?? escaneo.kind),
      texto(METODOS[escaneo.method] ?? escaneo.method),
      texto(escaneo.guard_name),
      entero(escaneo.fotos),
      texto(textoAnomalias(escaneo.anomalies)),
      desfaseEnMinutos(escaneo.clock_offset_ms),
    ]),
  };
}

function hojaNovedades(novedades: readonly NovedadExcelRow[]): HojaExcel {
  return {
    nombre: HOJA_NOVEDADES,
    columnas: [
      { titulo: 'Novedad (ID)', ancho: 38 },
      { titulo: 'Registrado en el servidor', ancho: 20 },
      { titulo: 'Hora del teléfono', ancho: 20 },
      { titulo: 'Recinto', ancho: 26 },
      { titulo: 'Sucursal', ancho: 22 },
      { titulo: 'Zona horaria', ancho: 18 },
      { titulo: 'Criticidad', ancho: 14 },
      { titulo: 'Detalle', ancho: 60 },
      { titulo: 'Guardia', ancho: 26 },
      { titulo: 'Ronda (ID)', ancho: 38 },
      { titulo: 'Fotos', ancho: 8 },
      { titulo: 'Corrige a (ID)', ancho: 38 },
    ],
    filas: novedades.map((novedad) => [
      texto(novedad.id),
      fechaHora(novedad.registrado_local),
      fechaHora(novedad.dispositivo_local),
      texto(novedad.site_name),
      texto(novedad.branch_name),
      texto(novedad.timezone),
      texto(CRITICIDADES[novedad.criticality] ?? novedad.criticality),
      texto(novedad.text),
      texto(novedad.guard_name),
      texto(novedad.patrol_id),
      entero(novedad.fotos),
      texto(novedad.corrects_event_id),
    ]),
  };
}

// ------------------------------------------------------------------ utiles

const PARTES_LOCAL = ['year', 'month', 'day', 'hour', 'minute', 'second'] as const;

/**
 * Instante -> hora de pared en la zona pedida, en texto sin zona.
 *
 * `Intl` con `hourCycle: 'h23'` es la unica forma de resolver una zona IANA sin
 * sumar una libreria de fechas. Con 'h24' —el default de algunas locales— la
 * medianoche sale como "24:00" del dia anterior y la fecha queda corrida.
 */
export function horaLocalIso(instante: Date, timezone: string): string | null {
  if (Number.isNaN(instante.getTime())) return null;
  try {
    const formato = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const partes = new Map(
      formato.formatToParts(instante).map((parte) => [parte.type, parte.value]),
    );
    const valores = PARTES_LOCAL.map((clave) => partes.get(clave));
    if (valores.some((valor) => valor === undefined)) return null;
    const [anio, mes, dia, hora, minuto, segundo] = valores as string[];
    return `${anio}-${mes}-${dia}T${hora}:${minuto}:${segundo}`;
  } catch {
    // Zona invalida guardada en sites.timezone: mejor UTC que un informe caido.
    return instante.toISOString().slice(0, 19);
  }
}
