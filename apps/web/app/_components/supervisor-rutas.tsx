/**
 * Cumplimiento por RUTA de un recinto (#99).
 *
 * El issue pide cumplimiento por guardia, por ruta y por punto. Por guardia lo
 * da `/stats/charts/guard-ranking`, por punto la tarjeta de omisiones, y por
 * ruta `GET /api/stats/charts/compliance-by-route`, que es de donde sale todo
 * lo de aca.
 *
 * Esta tarjeta se armaba antes en el navegador, agrupando el listado de rondas
 * del recinto. Se dejo de hacer asi porque ese listado tiene tres defectos que
 * ninguna cuenta del cliente podia corregir, y los tres cambiaban la conclusion:
 *
 * 1. Es `ORDER BY scheduled_start_at DESC LIMIT 100`: las 100 rondas con la
 *    fecha PROGRAMADA mas alta, FUTURAS incluidas. Un recinto con la semana ya
 *    generada llenaba esas 100 filas con rondas `pendiente` y el promedio salia
 *    de las pocas cerradas que sobraban.
 * 2. No expone `is_voluntary`, que el resto del panel excluye: dos tarjetas de
 *    la misma pantalla contaban universos distintos.
 * 3. No expone `route_id`, asi que se agrupaba por NOMBRE. Como `routes` no
 *    tiene UNIQUE sobre `name`, dos rutas distintas del mismo recinto llamadas
 *    igual se leian como una sola fila con el promedio mezclado.
 *
 * Ahora el corte del periodo lo hace el SQL contra `sites.timezone` y es el
 * MISMO que el del resto del panel, asi que las cifras de esta tarjeta y las de
 * arriba por fin hablan del mismo pedazo de tiempo.
 */

import { DescargarCsv } from './stats-charts-csv';
import {
  formatearEntero,
  formatearPorcentaje,
  plural,
  type CumplimientoPorRuta,
} from './stats-charts-data';
import { BarrasHorizontales, ChipsAlerta, TablaDatos, type BarraItem } from './stats-charts-svg';
import {
  TOPE_RUTAS,
  excesoDeDuracion,
  rutasTruncadas,
  type RecintoElegido,
  type ResultadoSupervisor,
} from './supervisor-datos';
import { EstadoSupervisor, TarjetaSupervisor, VacioSupervisor } from './supervisor-tarjeta';

const COLUMNAS = [
  'Ruta',
  'Rondas',
  'Completas',
  'Incompletas',
  'Vencidas',
  'Evaluadas',
  'Guardias',
  'Cumplimiento',
  'Bajo umbral',
  'Duración real',
  // El tamaño de la muestra va en su propia columna y no entre paréntesis: la
  // duración de una ruta medida sobre una sola ronda completa y sobre treinta se
  // leen igual de firmes si el número no está al lado.
  'Rondas medidas',
  'Estimada (min)',
];

/** Los minutos de mas —o de menos— dichos como se leen en una tabla. */
function textoExceso(exceso: number | null): string {
  if (exceso === null) return 'sin comparar';
  const minutos = Math.round(exceso);
  if (minutos > 0) return `+${formatearEntero(minutos)} min`;
  if (minutos < 0) return `${formatearEntero(minutos)} min`;
  return 'en hora';
}

export function SupervisorRutas({
  resultado,
  recinto,
}: {
  resultado: ResultadoSupervisor<CumplimientoPorRuta>;
  /** `null` cuando todavia no hay recinto elegido. */
  recinto: RecintoElegido | null;
}) {
  const datos = resultado.estado === 'ok' ? resultado.datos : null;
  const rutas = datos?.routes ?? [];
  /*
   * El umbral viaja DENTRO de esta respuesta y ya no llega por prop desde
   * `compliance-by-site`. Si aquella consulta fallaba y esta no, la tarjeta se
   * quedaba sin umbral y dejaba de marcar rutas bajo la linea sin decir por que.
   * Ahora el numero con el que se pintan las alertas es exactamente el mismo con
   * el que el servidor conto `belowThreshold`.
   */
  const umbral = datos?.threshold ?? null;
  const truncado = rutasTruncadas(rutas);

  const items: BarraItem[] = rutas.map((ruta) => ({
    clave: ruta.routeId,
    titulo: ruta.routeName,
    subtitulo: `${plural(ruta.ratedPatrols, 'ronda evaluada', 'rondas evaluadas')} · ${plural(
      ruta.guards,
      'guardia',
      'guardias',
    )}`,
    valor: ruta.compliancePct ?? 0,
    etiquetaValor: formatearPorcentaje(ruta.compliancePct),
    alerta: umbral !== null && ruta.compliancePct !== null && ruta.compliancePct < umbral,
    etiquetaAlerta: 'Bajo el umbral',
  }));

  /*
   * Rutas que en promedio se demoran mas de lo que dicen durar. Es lo que
   * convierte "esta ruta cumple poco" en algo que se puede arreglar: mientras la
   * ruta no quepa en su ventana, cambiar de guardia no mueve el numero.
   */
  const pasadas = rutas.filter((ruta) => {
    const exceso = excesoDeDuracion(ruta);
    return exceso !== null && exceso > 0;
  });

  const nombreRecinto = recinto?.nombre ?? 'el recinto que elegiste';

  return (
    <TarjetaSupervisor
      id="supervisor-rutas"
      eyebrow="Comparación"
      titulo="Cumplimiento por ruta"
      explicacion={`Cada ruta de ${nombreRecinto}, de peor a mejor, sobre las rondas ya terminadas del período elegido arriba. Una ruta que siempre queda a medias con guardias distintos no es un problema de personas: es una ruta que no cabe en el tiempo del turno, y se arregla sacándole puntos o alargando la ventana. Por eso al lado del cumplimiento va cuánto se demora de verdad y cuánto dice durar.`}
      insignia={rutas.length ? plural(rutas.length, 'ruta', 'rutas') : undefined}
    >
      <EstadoSupervisor resultado={resultado} />

      {recinto === null ? (
        <VacioSupervisor
          titulo="Elige un recinto arriba"
          detalle="El cumplimiento por ruta se mira recinto por recinto: las rutas de dos recintos distintos no se comparan entre sí."
        />
      ) : null}

      {recinto !== null && resultado.estado === 'ok' ? (
        rutas.length ? (
          <>
            <p className="section-explanation">
              Lo calcula el servidor sobre las rondas <strong>terminadas</strong> del período. Las
              pendientes y las que están en curso no entran: tienen puntos sin marcar porque
              todavía no les toca, no porque alguien los haya saltado. Las voluntarias tampoco,
              igual que en el resto del panel. La <strong>duración real</strong> sale solo de las
              rondas que se completaron —una ronda abandonada a medio camino mide hasta dónde se
              llegó, no cuánto toma la ruta—, y por eso al lado va sobre cuántas está medida.{' '}
              {truncado
                ? `Se muestran las ${formatearEntero(
                    TOPE_RUTAS,
                  )} rutas con peor cumplimiento, así que puede haber alguna más con mejor nota que no se ve.`
                : 'Están todas las rutas del recinto con rondas terminadas en el período.'}
            </p>

            {pasadas.length ? (
              <p className="stats-estado aviso" role="status">
                <strong>
                  {pasadas.length === 1
                    ? 'Una ruta se demora más de lo que dice durar:'
                    : `${formatearEntero(
                        pasadas.length,
                      )} rutas se demoran más de lo que dicen durar:`}
                </strong>{' '}
                {pasadas
                  .map(
                    (ruta) =>
                      `${ruta.routeName} (${textoExceso(excesoDeDuracion(ruta))} sobre ${plural(
                        ruta.durationSamples,
                        'ronda completa',
                        'rondas completas',
                      )})`,
                  )
                  .join(', ')}
                . Antes de hablar con los guardias, revisa si caben en la ventana del turno: el
                tiempo estimado se edita en la ruta. Y mira sobre cuántas rondas está medido: con
                una sola, el promedio todavía no dice nada.
              </p>
            ) : null}

            <BarrasHorizontales
              items={items}
              escala={100}
              referencia={
                umbral === null
                  ? undefined
                  : { valor: umbral, etiqueta: `Umbral ${formatearPorcentaje(umbral)}` }
              }
              ariaLabel={`Cumplimiento promedio por ruta. ${rutas
                .map(
                  (ruta) =>
                    `${ruta.routeName}: ${formatearPorcentaje(
                      ruta.compliancePct,
                    )} en ${formatearEntero(ruta.ratedPatrols)} rondas evaluadas`,
                )
                .join('. ')}.`}
            />
            <ChipsAlerta items={items} />

            <TablaDatos
              titulo="Cumplimiento por ruta"
              columnas={COLUMNAS}
              filas={rutas.map((ruta) => ({
                clave: ruta.routeId,
                alerta:
                  umbral !== null && ruta.compliancePct !== null && ruta.compliancePct < umbral,
                celdas: [
                  ruta.routeName,
                  formatearEntero(ruta.patrols),
                  formatearEntero(ruta.completed),
                  formatearEntero(ruta.incomplete),
                  formatearEntero(ruta.expired),
                  formatearEntero(ruta.ratedPatrols),
                  formatearEntero(ruta.guards),
                  formatearPorcentaje(ruta.compliancePct),
                  formatearEntero(ruta.belowThreshold),
                  ruta.avgDurationMin === null
                    ? 'Sin rondas completas'
                    : `${formatearEntero(Math.round(ruta.avgDurationMin))} min (${textoExceso(
                        excesoDeDuracion(ruta),
                      )})`,
                  formatearEntero(ruta.durationSamples),
                  formatearEntero(ruta.estimatedDurationMin),
                ],
              }))}
              acciones={
                <DescargarCsv
                  nombre="cumplimiento-por-ruta"
                  columnas={COLUMNAS}
                  filas={rutas.map((ruta) => [
                    ruta.routeName,
                    String(ruta.patrols),
                    String(ruta.completed),
                    String(ruta.incomplete),
                    String(ruta.expired),
                    String(ruta.ratedPatrols),
                    String(ruta.guards),
                    ruta.compliancePct === null ? '' : String(ruta.compliancePct),
                    String(ruta.belowThreshold),
                    ruta.avgDurationMin === null ? '' : String(ruta.avgDurationMin),
                    String(ruta.durationSamples),
                    String(ruta.estimatedDurationMin),
                  ])}
                />
              }
            />
          </>
        ) : (
          <VacioSupervisor
            titulo="Este recinto no tiene rondas terminadas en el período"
            detalle="La consulta funcionó y no devolvió ninguna ruta. Puede que las rondas del período sigan pendientes o en curso: hasta que cierren, su cumplimiento todavía no significa nada. Amplía el período de arriba para ver las anteriores."
          />
        )
      ) : null}
    </TarjetaSupervisor>
  );
}
