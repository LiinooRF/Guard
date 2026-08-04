/**
 * Cumplimiento por RUTA de un recinto (#99).
 *
 * El issue pide cumplimiento por guardia, por ruta y por punto. Por guardia ya
 * existe (`/stats/charts/guard-ranking`) y por punto lo cubre la tarjeta de
 * omisiones. Por ruta NO existe endpoint que lo agregue, asi que esta tarjeta
 * se arma con `GET /api/supervisor/sites/:siteId/patrols`, que es el listado de
 * rondas del recinto.
 *
 * Eso trae cuatro limitaciones REALES que se dicen en pantalla en vez de
 * disimularse, porque cada una puede cambiar la conclusion:
 *
 * 1. Ese endpoint es `ORDER BY p.scheduled_start_at DESC LIMIT 100`
 *    (`supervisor.service.ts`) y no acepta periodo. **No son "las ultimas 100
 *    rondas ocurridas": son las 100 con la fecha PROGRAMADA mas alta, futuras
 *    incluidas.** Como las rondas se generan por adelantado y un turno puede
 *    tener hasta 48 (`patrolsPerShift`, `@Max(48)`), un recinto con la semana ya
 *    generada llena esas 100 filas con rondas `pendiente` y el promedio termina
 *    saliendo de las pocas cerradas que sobran. Por eso la tarjeta cuenta cuantas
 *    del listado estan abiertas y avisa cuando dominan la muestra. Y por eso
 *    tampoco usa el filtro de fechas de arriba: recortar por fecha un listado ya
 *    recortado por cantidad daria un promedio de una muestra arbitraria.
 * 2. No expone `is_voluntary`, que el resto del panel excluye. Las rondas
 *    voluntarias entran aca y no en las otras tarjetas.
 * 3. No trae la zona horaria del recinto, asi que aca no se corta por dia ni se
 *    convierte ningun instante. Los cortes por fecha los hace el SQL del
 *    servidor, que si tiene `sites.timezone`.
 * 4. Tampoco expone `routeId`, asi que las rondas se agrupan por NOMBRE de ruta.
 *    Renombrar una ruta es libre y `routes` no tiene UNIQUE sobre `name`: dos
 *    rutas distintas del mismo recinto llamadas igual se leen como una sola fila
 *    con el promedio mezclado.
 *
 * La solucion de verdad es un `GET /api/stats/charts/compliance-by-route` que
 * agregue en SQL con el mismo corte por zona horaria que el resto. Queda pedido
 * en INTEGRACION.md; mientras tanto, esto responde la pregunta con la muestra
 * que hay y dice cual es.
 */

import { DescargarCsv } from './stats-charts-csv';
import { formatearEntero, formatearPorcentaje, plural } from './stats-charts-data';
import { BarrasHorizontales, ChipsAlerta, TablaDatos, type BarraItem } from './stats-charts-svg';
import {
  TOPE_RONDAS_LISTADO,
  agruparPorRuta,
  listadoTruncado,
  type RecintoElegido,
  type ResultadoSupervisor,
  type RondaSupervisor,
} from './supervisor-datos';
import { EstadoSupervisor, TarjetaSupervisor, VacioSupervisor } from './supervisor-tarjeta';

const COLUMNAS = [
  'Ruta',
  'Rondas',
  'Terminadas',
  'Evaluadas',
  'Completas',
  'Incompletas',
  'Vencidas',
  'Guardias',
  'Cumplimiento',
  'Bajo umbral',
];

export function SupervisorRutas({
  resultado,
  recinto,
  umbral,
}: {
  resultado: ResultadoSupervisor<RondaSupervisor[]>;
  /** `null` cuando todavia no hay recinto elegido. */
  recinto: RecintoElegido | null;
  /** Umbral de cumplimiento vigente, resuelto por el servidor. */
  umbral: number | null;
}) {
  const rondas = resultado.estado === 'ok' ? resultado.datos : [];
  const rutas = agruparPorRuta(rondas, umbral);
  const truncado = listadoTruncado(rondas);

  /*
   * Cuantas del listado todavia no terminaron. Importa decirlo porque el
   * endpoint ordena por `scheduled_start_at DESC`: si el recinto tiene rondas ya
   * generadas para los proximos dias, las FUTURAS son las primeras 100 y el
   * promedio de abajo sale de las pocas cerradas que quedan.
   */
  const abiertas = rutas.reduce((total, ruta) => total + ruta.abiertas, 0);
  const cerradas = rondas.length - abiertas;
  const dominanAbiertas = rondas.length > 0 && abiertas > cerradas;

  const items: BarraItem[] = rutas.map((ruta) => ({
    clave: ruta.ruta,
    titulo: ruta.ruta,
    subtitulo: `${plural(ruta.evaluadas, 'ronda evaluada', 'rondas evaluadas')} · ${plural(
      ruta.guardias,
      'guardia',
      'guardias',
    )}`,
    valor: ruta.promedio ?? 0,
    etiquetaValor: formatearPorcentaje(ruta.promedio),
    alerta: umbral !== null && ruta.promedio !== null && ruta.promedio < umbral,
    etiquetaAlerta: 'Bajo el umbral',
  }));

  const nombreRecinto = recinto?.nombre ?? 'el recinto que elegiste';

  return (
    <TarjetaSupervisor
      id="supervisor-rutas"
      eyebrow="Comparación"
      titulo="Cumplimiento por ruta"
      explicacion={`Cada ruta de ${nombreRecinto}, de peor a mejor. Una ruta que siempre queda a medias con guardias distintos no es un problema de personas: es una ruta que no cabe en el tiempo del turno, y se arregla sacándole puntos o alargando la ventana. Las rondas se agrupan por NOMBRE de ruta, porque el listado no entrega el id: dos rutas distintas de este recinto que se llamen igual aparecen como una sola fila con el promedio mezclado.`}
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
              Calculado sobre las {formatearEntero(rondas.length)} rondas que el servidor entrega
              para este recinto: las de <strong>fecha programada más reciente</strong>, incluidas
              las que todavía no ocurren.{' '}
              {truncado
                ? `Son el máximo de ${formatearEntero(
                    TOPE_RONDAS_LISTADO,
                  )} que entrega, así que puede haber más historia que no se ve.`
                : 'Es todo lo que hay programado y ejecutado en este recinto.'}{' '}
              De esas, {formatearEntero(cerradas)}{' '}
              {cerradas === 1 ? 'está terminada' : 'están terminadas'} y{' '}
              {formatearEntero(abiertas)}{' '}
              {abiertas === 1 ? 'sigue pendiente o en curso' : 'siguen pendientes o en curso'}: el
              promedio de cada ruta sale solo de las terminadas. No depende del período elegido
              arriba, a diferencia del resto del panel.
            </p>

            {dominanAbiertas ? (
              <p className="stats-estado aviso" role="status">
                <strong>La mayoría de estas rondas todavía no ha terminado.</strong> El listado trae las
                de fecha programada más alta primero, y en este recinto hay{' '}
                {formatearEntero(abiertas)} rondas pendientes o en curso frente a{' '}
                {formatearEntero(cerradas)} terminadas. El cumplimiento de abajo se calcula sobre
                esas {formatearEntero(cerradas)}, así que léelo como una muestra chica y reciente,
                no como el cumplimiento histórico de la ruta.
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
                    `${ruta.ruta}: ${formatearPorcentaje(ruta.promedio)} en ${formatearEntero(
                      ruta.evaluadas,
                    )} rondas evaluadas`,
                )
                .join('. ')}.`}
            />
            <ChipsAlerta items={items} />

            <TablaDatos
              titulo="Cumplimiento por ruta"
              columnas={COLUMNAS}
              filas={rutas.map((ruta) => ({
                clave: ruta.ruta,
                alerta: umbral !== null && ruta.promedio !== null && ruta.promedio < umbral,
                celdas: [
                  ruta.ruta,
                  formatearEntero(ruta.rondas),
                  formatearEntero(ruta.cerradas),
                  formatearEntero(ruta.evaluadas),
                  formatearEntero(ruta.completadas),
                  formatearEntero(ruta.incompletas),
                  formatearEntero(ruta.vencidas),
                  formatearEntero(ruta.guardias),
                  formatearPorcentaje(ruta.promedio),
                  ruta.bajoUmbral === null ? 'Sin umbral' : formatearEntero(ruta.bajoUmbral),
                ],
              }))}
              acciones={
                <DescargarCsv
                  nombre="cumplimiento-por-ruta"
                  columnas={COLUMNAS}
                  filas={rutas.map((ruta) => [
                    ruta.ruta,
                    String(ruta.rondas),
                    String(ruta.cerradas),
                    String(ruta.evaluadas),
                    String(ruta.completadas),
                    String(ruta.incompletas),
                    String(ruta.vencidas),
                    String(ruta.guardias),
                    ruta.promedio === null ? '' : String(ruta.promedio),
                    ruta.bajoUmbral === null ? '' : String(ruta.bajoUmbral),
                  ])}
                />
              }
            />
          </>
        ) : (
          <VacioSupervisor
            titulo="Este recinto todavía no tiene rondas registradas"
            detalle="La consulta funcionó y no devolvió ninguna ronda. En cuanto se programe y ejecute la primera, su ruta aparecerá acá."
          />
        )
      ) : null}
    </TarjetaSupervisor>
  );
}
