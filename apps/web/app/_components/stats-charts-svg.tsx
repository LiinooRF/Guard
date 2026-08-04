/**
 * Graficas dibujadas a mano en SVG (#87).
 *
 * Sin libreria de graficos, y no por deporte: la misma web se abre dentro de un
 * WebView en telefonos de gama baja que la empresa le entrega al guardia, y
 * doscientos kilobytes de bundle se pagan en segundos de carga en terreno. Una
 * barra y una linea son cuarenta lineas de SVG.
 *
 * Nada de esto lleva `'use client'`: son componentes de presentacion puros que
 * se renderizan en el servidor y llegan al navegador como HTML. Cero JavaScript
 * enviado por grafica.
 *
 * Tres reglas que se respetan en todas:
 *
 * 1. El ancho de las barras va en PORCENTAJE, no en unidades de un `viewBox`.
 *    Asi la grafica se estira con la tarjeta y el texto conserva su tamaño en
 *    pixeles: con `viewBox` + `meet`, en una pantalla ancha las etiquetas se
 *    inflan hasta parecer titulos.
 * 2. Toda serie lleva su cifra escrita y toda grafica lleva su tabla. Una
 *    grafica que solo comunica por color no sirve impresa en blanco y negro, ni
 *    para quien no distingue rojo de verde.
 * 3. El `<svg>` lleva `role="img"` y un `aria-label` que RESUME el dato —no que
 *    diga "gráfico de barras"—, porque eso es lo unico que va a escuchar quien
 *    use lector de pantalla.
 */

import type { ReactNode } from 'react';

import {
  anclaTexto,
  escalaAgradable,
  etiquetaBucket,
  formatearEntero,
  formatearPorcentaje,
  fraccion,
  indicesEtiquetados,
  normalizarDia,
  posicionEtiqueta,
  posicionSerie,
  truncar,
  type Granularidad,
  type PuntoEvolucion,
} from './stats-charts-data';

/* ================================================================== */
/* Barras horizontales                                                 */
/* ================================================================== */

export interface BarraItem {
  clave: string;
  titulo: string;
  subtitulo?: string;
  /** Valor en las unidades del eje (porcentaje o conteo). */
  valor: number;
  /** Cifra escrita al lado de la barra. */
  etiquetaValor: string;
  /** Marca de estado: pinta la barra con el color de alerta Y muestra el chip. */
  alerta?: boolean;
  /** Texto del chip de estado. Sin esto, la alerta seria solo color. */
  etiquetaAlerta?: string;
}

const ALTO_FILA = 52;
const ALTO_BARRA = 14;

/**
 * Lista de barras horizontales, una por fila, con el nombre encima de la barra.
 *
 * El nombre va ARRIBA y no en una columna a la izquierda: los recintos se
 * llaman "Estacionamiento subterráneo nivel -2", y una columna que aguante eso
 * deja la barra sin ancho. Arriba tiene la tarjeta entera.
 */
export function BarrasHorizontales({
  items,
  escala,
  referencia,
  ariaLabel,
}: {
  items: BarraItem[];
  /** Maximo del eje. Para porcentajes es 100. */
  escala: number;
  referencia?: { valor: number; etiqueta: string };
  ariaLabel: string;
}) {
  const alto = items.length * ALTO_FILA + (referencia ? 24 : 6);
  const referenciaPct = referencia ? fraccion(referencia.valor, escala) * 100 : 0;

  return (
    <svg className="stats-grafica" width="100%" height={alto} role="img" aria-label={ariaLabel}>
      {referencia ? (
        <>
          <line
            className="stats-referencia"
            x1={`${referenciaPct}%`}
            x2={`${referenciaPct}%`}
            y1={14}
            y2={items.length * ALTO_FILA - 4}
          />
          <text
            className="stats-referencia-texto"
            x={`${referenciaPct}%`}
            y={items.length * ALTO_FILA + 16}
            textAnchor={anclaTexto(referenciaPct)}
          >
            {referencia.etiqueta}
          </text>
        </>
      ) : null}

      {items.map((item, indice) => {
        const y = indice * ALTO_FILA;
        const parte = fraccion(item.valor, escala);
        const ancho = parte * 100;
        const dentro = posicionEtiqueta(parte) === 'dentro';
        return (
          <g key={item.clave}>
            <title>
              {item.titulo}: {item.etiquetaValor}
              {item.subtitulo ? ` · ${item.subtitulo}` : ''}
            </title>
            <text className="stats-barra-titulo" x={0} y={y + 13}>
              {truncar(item.titulo, 48)}
              {item.subtitulo ? (
                <tspan className="stats-barra-sub"> · {truncar(item.subtitulo, 46)}</tspan>
              ) : null}
            </text>

            <rect className="stats-barra-pista" x={0} y={y + 22} width="100%" height={ALTO_BARRA} rx={4} />
            <rect
              className={item.alerta ? 'stats-barra alerta' : 'stats-barra'}
              x={0}
              y={y + 22}
              width={`${ancho}%`}
              height={ALTO_BARRA}
              rx={4}
            />
            {/* Cuadra el extremo pegado a la linea base: el dato nace ahi, no
                flota. Solo si la barra da el ancho para que se note. */}
            {ancho > 3 ? (
              <rect
                className={item.alerta ? 'stats-barra alerta' : 'stats-barra'}
                x={0}
                y={y + 22}
                width={4}
                height={ALTO_BARRA}
              />
            ) : null}

            <text
              className={dentro ? 'stats-barra-valor dentro' : 'stats-barra-valor'}
              x={`${ancho}%`}
              dx={dentro ? -8 : 8}
              y={y + 33}
              textAnchor={dentro ? 'end' : 'start'}
            >
              {item.etiquetaValor}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

/**
 * Chips de estado que acompañan a las barras en alerta.
 *
 * Van fuera del SVG, como texto normal: es lo que hace que la alerta no sea
 * solo un color. Se lee igual en blanco y negro y lo anuncia el lector de
 * pantalla.
 */
export function ChipsAlerta({ items }: { items: BarraItem[] }) {
  const alertados = items.filter((item) => item.alerta && item.etiquetaAlerta);
  if (!alertados.length) return null;
  return (
    <ul className="stats-alertas">
      {alertados.map((item) => (
        <li key={item.clave}>
          <span className="stats-chip alerta">{item.etiquetaAlerta}</span> {truncar(item.titulo, 44)}
        </li>
      ))}
    </ul>
  );
}

/* ================================================================== */
/* Serie de cumplimiento en el tiempo                                  */
/* ================================================================== */

const SERIE_MARGEN_SUP = 16;
const SERIE_ALTO_PLOT = 176;
const SERIE_MARGEN_INF = 28;
const REJILLA = [0, 25, 50, 75, 100] as const;

/** Cuantos puntos aguanta la serie antes de que los circulos sean ruido. */
const MAX_PUNTOS_CON_MARCA = 31;

export function SerieCumplimiento({
  puntos,
  granularidad,
  umbral,
  ariaLabel,
}: {
  puntos: PuntoEvolucion[];
  granularidad: Granularidad;
  umbral: number;
  ariaLabel: string;
}) {
  const alto = SERIE_MARGEN_SUP + SERIE_ALTO_PLOT + SERIE_MARGEN_INF;
  const y = (valor: number) => SERIE_MARGEN_SUP + (1 - fraccion(valor, 100)) * SERIE_ALTO_PLOT;
  const total = puntos.length;
  const conDato = puntos
    .map((punto, indice) => ({ punto, indice }))
    .filter((par) => par.punto.compliancePct !== null);

  const ultimo = conDato[conDato.length - 1];
  const minimo = conDato.reduce<(typeof conDato)[number] | undefined>(
    (peor, actual) =>
      peor === undefined ||
      (actual.punto.compliancePct ?? 100) < (peor.punto.compliancePct ?? 100)
        ? actual
        : peor,
    undefined,
  );
  const destacados = new Set<number>();
  if (ultimo) destacados.add(ultimo.indice);
  if (minimo) destacados.add(minimo.indice);
  const etiquetasEje = new Set(indicesEtiquetados(total));

  return (
    <svg className="stats-grafica" width="100%" height={alto} role="img" aria-label={ariaLabel}>
      {REJILLA.map((valor) => (
        <g key={valor}>
          <line className="stats-rejilla" x1={0} x2="100%" y1={y(valor)} y2={y(valor)} />
          <text className="stats-eje" x={0} y={y(valor) - 4}>
            {valor}%
          </text>
        </g>
      ))}

      <line className="stats-umbral" x1={0} x2="100%" y1={y(umbral)} y2={y(umbral)} />
      <text className="stats-umbral-texto" x="100%" y={y(umbral) - 5} textAnchor="end">
        Umbral {formatearPorcentaje(umbral)}
      </text>

      {/* La linea se dibuja tramo a tramo y no como `polyline` porque las
          coordenadas van en porcentaje —que `points` no acepta— y porque asi un
          periodo sin rondas queda como HUECO y no como una caida a cero. Un
          cero inventado en un informe de cumplimiento es peor que un vacio. */}
      {puntos.slice(0, -1).map((punto, indice) => {
        const siguiente = puntos[indice + 1];
        if (punto.compliancePct === null || !siguiente || siguiente.compliancePct === null) {
          return null;
        }
        return (
          <line
            key={`tramo-${punto.bucket}`}
            className="stats-linea"
            x1={`${posicionSerie(indice, total)}%`}
            y1={y(punto.compliancePct)}
            x2={`${posicionSerie(indice + 1, total)}%`}
            y2={y(siguiente.compliancePct)}
          />
        );
      })}

      {puntos.map((punto, indice) => {
        if (punto.compliancePct === null) return null;
        const marca = total <= MAX_PUNTOS_CON_MARCA || destacados.has(indice);
        const posicion = posicionSerie(indice, total);
        const dia = normalizarDia(punto.bucket);
        return (
          <g key={`punto-${punto.bucket}`}>
            <title>
              {etiquetaBucket(dia, granularidad)}: {formatearPorcentaje(punto.compliancePct)} ·{' '}
              {formatearEntero(punto.patrols)} rondas
            </title>
            {marca ? (
              <circle
                className="stats-marca"
                cx={`${posicion}%`}
                cy={y(punto.compliancePct)}
                r={4}
              />
            ) : null}
            {destacados.has(indice) ? (
              <text
                className="stats-valor-serie"
                x={`${posicion}%`}
                y={y(punto.compliancePct) - 11}
                textAnchor={anclaTexto(posicion)}
              >
                {formatearPorcentaje(punto.compliancePct)}
              </text>
            ) : null}
          </g>
        );
      })}

      {puntos.map((punto, indice) =>
        etiquetasEje.has(indice) ? (
          <text
            key={`eje-${punto.bucket}`}
            className="stats-eje"
            x={`${posicionSerie(indice, total)}%`}
            y={SERIE_MARGEN_SUP + SERIE_ALTO_PLOT + 18}
            textAnchor={anclaTexto(posicionSerie(indice, total))}
          >
            {etiquetaBucket(normalizarDia(punto.bucket), granularidad)}
          </text>
        ) : null,
      )}
    </svg>
  );
}

/* ================================================================== */
/* Columnas: rondas programadas vs completadas                         */
/* ================================================================== */

const COL_MARGEN_SUP = 14;
const COL_ALTO_PLOT = 104;
const COL_MARGEN_INF = 26;

export function ColumnasRondas({
  puntos,
  granularidad,
  ariaLabel,
}: {
  puntos: PuntoEvolucion[];
  granularidad: Granularidad;
  ariaLabel: string;
}) {
  const alto = COL_MARGEN_SUP + COL_ALTO_PLOT + COL_MARGEN_INF;
  const escala = escalaAgradable(Math.max(...puntos.map((punto) => punto.patrols), 1));
  const total = puntos.length;
  const y = (valor: number) => COL_MARGEN_SUP + (1 - fraccion(valor, escala)) * COL_ALTO_PLOT;
  const base = COL_MARGEN_SUP + COL_ALTO_PLOT;
  // Ancho en porcentaje, con tope: con seis periodos una columna de un sexto
  // del ancho es un bloque, y los bloques gruesos gritan.
  const ancho = Math.min((100 / Math.max(total, 1)) * 0.62, 3.2);
  const etiquetasEje = new Set(indicesEtiquetados(total));

  return (
    <svg className="stats-grafica" width="100%" height={alto} role="img" aria-label={ariaLabel}>
      {[0, escala / 2, escala].map((valor) => (
        <g key={valor}>
          <line className="stats-rejilla" x1={0} x2="100%" y1={y(valor)} y2={y(valor)} />
          <text className="stats-eje" x={0} y={y(valor) - 4}>
            {formatearEntero(valor)}
          </text>
        </g>
      ))}

      {puntos.map((punto, indice) => {
        const centro = posicionSerie(indice, total);
        const x = Math.min(Math.max(centro - ancho / 2, 0), 100 - ancho);
        const dia = normalizarDia(punto.bucket);
        return (
          <g key={`columna-${punto.bucket}`}>
            <title>
              {etiquetaBucket(dia, granularidad)}: {formatearEntero(punto.completed)} completadas de{' '}
              {formatearEntero(punto.patrols)} programadas
            </title>
            <rect
              className="stats-columna-pista"
              x={`${x}%`}
              y={y(punto.patrols)}
              width={`${ancho}%`}
              height={Math.max(base - y(punto.patrols), 0)}
              rx={2}
            />
            <rect
              className="stats-columna"
              x={`${x}%`}
              y={y(punto.completed)}
              width={`${ancho}%`}
              height={Math.max(base - y(punto.completed), 0)}
              rx={2}
            />
          </g>
        );
      })}

      {puntos.map((punto, indice) =>
        etiquetasEje.has(indice) ? (
          <text
            key={`eje-col-${punto.bucket}`}
            className="stats-eje"
            x={`${posicionSerie(indice, total)}%`}
            y={base + 17}
            textAnchor={anclaTexto(posicionSerie(indice, total))}
          >
            {etiquetaBucket(normalizarDia(punto.bucket), granularidad)}
          </text>
        ) : null,
      )}
    </svg>
  );
}

/* ================================================================== */
/* Leyenda y tabla                                                     */
/* ================================================================== */

export function Leyenda({
  items,
}: {
  items: Array<{ clave: string; etiqueta: string; tipo: 'relleno' | 'pista' | 'linea' | 'alerta' }>;
}) {
  return (
    <ul className="stats-leyenda">
      {items.map((item) => (
        <li key={item.clave}>
          <span className={`stats-marca-leyenda ${item.tipo}`} aria-hidden="true" />
          {item.etiqueta}
        </li>
      ))}
    </ul>
  );
}

/**
 * El gemelo en tabla de cada grafica.
 *
 * Va colapsado para no llenar la pantalla, pero al imprimir se abre solo (ver
 * el bloque `@media print` del CSS): un informe impreso sin las cifras no sirve
 * de nada, y es el caso real —el jefe de operaciones imprime y lo lleva a la
 * reunion.
 */
export function TablaDatos({
  columnas,
  filas,
  titulo,
  acciones,
}: {
  columnas: string[];
  filas: Array<{ clave: string; celdas: string[]; alerta?: boolean }>;
  titulo: string;
  acciones?: ReactNode;
}) {
  return (
    <details className="stats-detalle">
      <summary>Ver los datos en tabla ({filas.length})</summary>
      <div className="stats-detalle-cuerpo">
        {acciones ? <div className="stats-detalle-acciones">{acciones}</div> : null}
        <div className="stats-tabla-envoltura">
          <table className="stats-tabla">
            <caption className="stats-invisible">{titulo}</caption>
            <thead>
              <tr>
                {columnas.map((columna, indice) => (
                  <th key={columna} scope="col" className={indice === 0 ? '' : 'numerica'}>
                    {columna}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filas.map((fila) => (
                <tr key={fila.clave} className={fila.alerta ? 'alerta' : undefined}>
                  {fila.celdas.map((celda, indice) =>
                    indice === 0 ? (
                      <th key={indice} scope="row">
                        {celda}
                      </th>
                    ) : (
                      <td key={indice} className="numerica">
                        {celda}
                      </td>
                    ),
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}
