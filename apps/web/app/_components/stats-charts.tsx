/**
 * Informes con graficas por sucursal (#87) — ADMIN y SUPERVISOR.
 *
 * Componente de SERVIDOR. Lee la cookie `voxia_access` y pide las cuatro series
 * a `/api/stats/charts/*` por la red interna, igual que hace
 * `app/app/[role]/page.tsx`. Al navegador no viaja ni un token, ni una llamada
 * a la API, ni una libreria de graficos: llega HTML con SVG dentro.
 *
 * El estado del panel vive en la URL (`?desde=&hasta=&recinto=&sucursal=
 * &agrupacion=`). Cambiar un filtro es una navegacion, no un `useEffect`: se
 * puede compartir el enlace, y el boton "atras" del navegador funciona.
 *
 * Tres cosas que este archivo trata con cuidado, porque son las que se hacen
 * mal:
 *
 * · **403 no es una falla.** Al SUPERVISOR le corresponden solo sus recintos
 *   asignados; si pide otro, la API responde 403 y aca se lee "no tienes este
 *   recinto asignado", no "error al cargar".
 * · **Vacio no es cero.** "Todavia no hay rondas cerradas en este periodo" y
 *   "no pudimos cargar" son dos pantallas distintas, y ninguna de las dos es
 *   una grafica dibujada en cero. Una grafica en cero se lee como "aqui no pasa
 *   nada", que es exactamente lo contrario de "no sabemos".
 * · **El rango se acota antes de pedirlo.** Cada grafica tiene su tope y el que
 *   se pasa ni siquiera se consulta: se explica por que en la tarjeta.
 */

import type { ReactNode } from 'react';
import { cookies } from 'next/headers';

import { DescargarCsv } from './stats-charts-csv';
import {
  MOTIVO_TOPE,
  TOPE_DIAS,
  agruparPorSucursal,
  escalaAgradable,
  etiquetaRango,
  formatearEntero,
  formatearPorcentaje,
  granularidadSugerida,
  hoyUtc,
  normalizarDia,
  opcionesDeRecinto,
  opcionesDeSucursal,
  plural,
  resolverRangoPanel,
  resumirCumplimiento,
  type ClaveGrafica,
  type CumplimientoPorRecinto,
  type Evolucion,
  type Granularidad,
  type PuntosOmitidos,
  type RankingGuardias,
} from './stats-charts-data';
import { StatsChartsFilters, type ValoresFiltro } from './stats-charts-filters';
import {
  BarrasHorizontales,
  ChipsAlerta,
  ColumnasRondas,
  Leyenda,
  SerieCumplimiento,
  TablaDatos,
  type BarraItem,
} from './stats-charts-svg';

type ParametrosUrl = Record<string, string | string[] | undefined>;

/* ------------------------------------------------------------------ */
/* Carga de datos                                                      */
/* ------------------------------------------------------------------ */

/**
 * Estado de una grafica. Es un union y no un `T | null` justamente para que
 * "vacio", "sin permiso" y "se cayo" no puedan confundirse en el render.
 */
type Resultado<T> =
  | { estado: 'ok'; datos: T }
  | { estado: 'sin-sesion' }
  | { estado: 'sin-permiso' }
  | { estado: 'rango-rechazado'; mensaje: string }
  | { estado: 'error' }
  | { estado: 'fuera-de-tope'; clave: ClaveGrafica };

function apiPublica() {
  return process.env.NEXT_PUBLIC_API_URL ?? '/api';
}

async function pedir<T>(ruta: string, parametros: URLSearchParams): Promise<Resultado<T>> {
  const almacen = await cookies();
  const acceso = almacen.get('voxia_access');
  if (!acceso) return { estado: 'sin-sesion' };

  try {
    const respuesta = await fetch(
      `${process.env.API_INTERNAL_URL ?? apiPublica()}${ruta}?${parametros.toString()}`,
      {
        headers: { cookie: `voxia_access=${acceso.value}` },
        cache: 'no-store',
      },
    );
    if (respuesta.ok) return { estado: 'ok', datos: (await respuesta.json()) as T };
    // 403 es el alcance por recinto funcionando, no una falla del panel.
    if (respuesta.status === 403) return { estado: 'sin-permiso' };
    if (respuesta.status === 400) {
      const cuerpo = (await respuesta.json().catch(() => null)) as { message?: string | string[] } | null;
      const mensaje = Array.isArray(cuerpo?.message) ? cuerpo?.message.join('. ') : cuerpo?.message;
      return { estado: 'rango-rechazado', mensaje: mensaje ?? 'El período pedido no es válido.' };
    }
    return { estado: 'error' };
  } catch {
    return { estado: 'error' };
  }
}

/* ------------------------------------------------------------------ */
/* Componente                                                          */
/* ------------------------------------------------------------------ */

export async function StatsCharts({
  role,
  searchParams,
}: {
  role: 'ADMIN' | 'SUPERVISOR';
  /**
   * Los `searchParams` de la pagina. Se aceptan ya resueltos o como promesa
   * —que es como los entrega Next 15— para que engancharlo sea una linea.
   * Sin esto el panel abre igual, con el ultimo mes; lo que se pierde son los
   * filtros.
   */
  searchParams?: ParametrosUrl | Promise<ParametrosUrl>;
}) {
  const parametros: ParametrosUrl = (await searchParams) ?? {};
  const texto = (clave: string): string | undefined => {
    const valor = parametros[clave];
    return Array.isArray(valor) ? valor[0] : valor;
  };

  const hoy = hoyUtc();
  const rango = resolverRangoPanel(texto('desde'), texto('hasta'), hoy);
  const recintoPedido = texto('recinto') ?? '';
  const sucursalPedida = texto('sucursal') ?? '';
  const agrupacionPedida = texto('agrupacion');
  const agrupacion: Granularidad =
    agrupacionPedida === 'dia' || agrupacionPedida === 'semana' || agrupacionPedida === 'mes'
      ? agrupacionPedida
      : granularidadSugerida(rango.dias);

  const comunes = () => {
    const busqueda = new URLSearchParams({ from: rango.desde, to: rango.hasta });
    if (recintoPedido) busqueda.set('siteId', recintoPedido);
    if (sucursalPedida) busqueda.set('branchName', sucursalPedida);
    return busqueda;
  };

  const dentroDeTope = (clave: ClaveGrafica) => rango.dias <= TOPE_DIAS[clave];
  const fuera = (clave: ClaveGrafica): Resultado<never> => ({ estado: 'fuera-de-tope', clave });

  const evolucionParams = comunes();
  evolucionParams.set('granularity', agrupacion);
  const omitidosParams = comunes();
  omitidosParams.set('limit', '12');
  const rankingParams = comunes();
  rankingParams.set('limit', '15');

  const [cumplimiento, evolucion, omitidos, ranking] = await Promise.all([
    dentroDeTope('cumplimiento')
      ? pedir<CumplimientoPorRecinto>('/stats/charts/compliance-by-site', comunes())
      : Promise.resolve(fuera('cumplimiento')),
    dentroDeTope('evolucion')
      ? pedir<Evolucion>('/stats/charts/evolution', evolucionParams)
      : Promise.resolve(fuera('evolucion')),
    dentroDeTope('omitidos')
      ? pedir<PuntosOmitidos>('/stats/charts/missed-checkpoints', omitidosParams)
      : Promise.resolve(fuera('omitidos')),
    dentroDeTope('ranking')
      ? pedir<RankingGuardias>('/stats/charts/guard-ranking', rankingParams)
      : Promise.resolve(fuera('ranking')),
  ]);

  const recintos = cumplimiento.estado === 'ok' ? cumplimiento.datos.sites : [];
  const resumen = resumirCumplimiento(recintos);
  const umbral = cumplimiento.estado === 'ok' ? cumplimiento.datos.threshold : null;
  const periodo = etiquetaRango(rango);
  const valores: ValoresFiltro = {
    desde: rango.desde,
    hasta: rango.hasta,
    recinto: recintoPedido,
    sucursal: sucursalPedida,
    agrupacion,
  };

  return (
    <section className="stats-seccion" id="informes">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Informes</span>
          <h2>Cumplimiento por sucursal</h2>
        </div>
        <span className="status-pill">{plural(rango.dias, 'día', 'días')}</span>
      </div>
      <p className="section-explanation">
        Todo lo de abajo corresponde al período {periodo}
        {recintoPedido || sucursalPedida ? ', filtrado como pediste' : ''}.{' '}
        {role === 'SUPERVISOR'
          ? 'Solo se cuentan los recintos que tienes asignados.'
          : 'Se cuentan todos los recintos de la empresa.'}
      </p>

      {rango.ajustado ? (
        <p className="stats-estado aviso" role="status">
          El período que traía el enlace no servía —o se pasaba de los dos años que el panel
          puede mostrar—, así que se ajustó al que ves arriba.
        </p>
      ) : null}

      <StatsChartsFilters
        valores={valores}
        recintos={opcionesDeRecinto(recintos)}
        sucursales={opcionesDeSucursal(recintos)}
        hoy={hoy}
        vista={texto('vista')}
      />

      {/* --------------------------------------------------------- */}
      {/* Cifras de cabecera                                        */}
      {/* --------------------------------------------------------- */}
      {cumplimiento.estado === 'ok' && recintos.length ? (
        <div className="stat-grid stats-cifras">
          <article className="stat-card stats-cifra">
            <span>Cumplimiento promedio</span>
            <strong>{formatearPorcentaje(resumen.promedio)}</strong>
            <small>
              Ponderado por ronda · umbral {umbral === null ? '—' : formatearPorcentaje(umbral)}
            </small>
          </article>
          <article className="stat-card stats-cifra">
            <span>Rondas del período</span>
            <strong>{formatearEntero(resumen.rondas)}</strong>
            <small>{formatearEntero(resumen.completadas)} completadas</small>
          </article>
          <article
            className={`stat-card stats-cifra${resumen.bajoUmbral ? ' alerta' : ''}`}
          >
            <span>Recintos bajo el umbral</span>
            <strong>{formatearEntero(resumen.bajoUmbral)}</strong>
            <small>
              {resumen.bajoUmbral === 0
                ? `Los ${formatearEntero(resumen.recintos)} están sobre el umbral`
                : `de ${formatearEntero(resumen.recintos)} recintos con rondas`}
            </small>
          </article>
        </div>
      ) : null}

      <div className="stats-grid">
        <TarjetaSucursales
          resultado={cumplimiento}
          periodo={periodo}
          umbral={umbral}
          role={role}
        />
        <TarjetaRecintos resultado={cumplimiento} periodo={periodo} umbral={umbral} role={role} />
      </div>

      <TarjetaEvolucion resultado={evolucion} periodo={periodo} role={role} />

      <div className="stats-grid">
        <TarjetaOmitidos resultado={omitidos} periodo={periodo} role={role} />
        <TarjetaRanking resultado={ranking} periodo={periodo} role={role} />
      </div>

      {recintoPedido ? (
        <p className="section-explanation">
          <a
            className="secondary-button stats-boton"
            href={`${apiPublica()}/reports/sites/${recintoPedido}?from=${rango.desde}&to=${rango.hasta}`}
            target="_blank"
            rel="noreferrer"
          >
            Descargar el informe en PDF de este recinto
          </a>
        </p>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Tarjeta y estados                                                   */
/* ------------------------------------------------------------------ */

function Tarjeta({
  id,
  eyebrow,
  titulo,
  explicacion,
  insignia,
  children,
}: {
  id: string;
  eyebrow: string;
  titulo: string;
  explicacion: string;
  insignia?: string;
  children: ReactNode;
}) {
  return (
    <section className="management-card stats-tarjeta" id={id}>
      <div className="card-heading">
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h2>{titulo}</h2>
        </div>
        {insignia ? <span className="status-pill">{insignia}</span> : null}
      </div>
      <p className="section-explanation">{explicacion}</p>
      {children}
    </section>
  );
}

/**
 * Traduce un resultado que no trajo datos a algo que se pueda leer.
 *
 * Devuelve `null` cuando hay datos: ahi manda el render de la grafica.
 */
function Estado({
  resultado,
  role,
}: {
  resultado: Resultado<unknown>;
  role: 'ADMIN' | 'SUPERVISOR';
}) {
  if (resultado.estado === 'ok') return null;

  if (resultado.estado === 'fuera-de-tope') {
    return (
      <p className="stats-estado aviso" role="status">
        <strong>Período demasiado largo para esta gráfica.</strong>{' '}
        {MOTIVO_TOPE[resultado.clave]} Acorta el período arriba y vuelve a aplicar.
      </p>
    );
  }

  if (resultado.estado === 'sin-permiso') {
    return (
      <p className="stats-estado aviso" role="status">
        <strong>No tienes este recinto asignado.</strong>{' '}
        {role === 'SUPERVISOR'
          ? 'Pide a un administrador de la empresa que te lo asigne, o elige uno de los tuyos en el filtro.'
          : 'Elige otro recinto en el filtro.'}
      </p>
    );
  }

  if (resultado.estado === 'rango-rechazado') {
    return (
      <p className="stats-estado aviso" role="status">
        <strong>El período no sirve para esta gráfica.</strong> {resultado.mensaje}
      </p>
    );
  }

  if (resultado.estado === 'sin-sesion') {
    return (
      <p className="stats-estado error" role="alert">
        <strong>Tu sesión venció.</strong> Vuelve a entrar para ver los informes.
      </p>
    );
  }

  return (
    <p className="stats-estado error" role="alert">
      <strong>No pudimos cargar esta gráfica.</strong> No es que no haya rondas: no logramos
      consultarlas. Actualiza la página en un momento más.
    </p>
  );
}

/** Vacio de verdad: la consulta funciono y no hay nada que mostrar. */
function Vacio({ titulo, detalle }: { titulo: string; detalle: string }) {
  return (
    <div className="dashboard-empty stats-vacio">
      <strong>{titulo}</strong>
      <span>{detalle}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Las cuatro graficas                                                 */
/* ------------------------------------------------------------------ */

function TarjetaSucursales({
  resultado,
  periodo,
  umbral,
  role,
}: {
  resultado: Resultado<CumplimientoPorRecinto>;
  periodo: string;
  umbral: number | null;
  role: 'ADMIN' | 'SUPERVISOR';
}) {
  const sucursales = resultado.estado === 'ok' ? agruparPorSucursal(resultado.datos.sites) : [];
  const items: BarraItem[] = sucursales.map((sucursal) => ({
    clave: sucursal.sucursal,
    titulo: sucursal.sucursal,
    subtitulo: `${plural(sucursal.recintos, 'recinto', 'recintos')} · ${plural(
      sucursal.rondas,
      'ronda',
      'rondas',
    )}`,
    valor: sucursal.promedio ?? 0,
    etiquetaValor: formatearPorcentaje(sucursal.promedio),
    alerta: umbral !== null && sucursal.promedio !== null && sucursal.promedio < umbral,
    etiquetaAlerta: 'Bajo el umbral',
  }));

  return (
    <Tarjeta
      id="informes-sucursales"
      eyebrow="Comparación"
      titulo="Cumplimiento por sucursal"
      explicacion="Todas tus sucursales en una sola pantalla, de peor a mejor. Es lo primero que conviene mirar: dice dónde está el problema, no cuánto se cumplió en total."
      insignia={sucursales.length ? `${sucursales.length} sucursales` : undefined}
    >
      <Estado resultado={resultado} role={role} />
      {resultado.estado === 'ok' ? (
        sucursales.length ? (
          <>
            <BarrasHorizontales
              items={items}
              escala={100}
              referencia={
                umbral === null
                  ? undefined
                  : { valor: umbral, etiqueta: `Umbral ${formatearPorcentaje(umbral)}` }
              }
              ariaLabel={`Cumplimiento promedio por sucursal, ${periodo}. ${sucursales
                .map(
                  (sucursal) =>
                    `${sucursal.sucursal}: ${formatearPorcentaje(sucursal.promedio)}`,
                )
                .join('. ')}.`}
            />
            <ChipsAlerta items={items} />
            <TablaDatos
              titulo={`Cumplimiento por sucursal, ${periodo}`}
              columnas={['Sucursal', 'Recintos', 'Rondas', 'Cumplimiento', 'Bajo umbral']}
              filas={sucursales.map((sucursal) => ({
                clave: sucursal.sucursal,
                alerta: umbral !== null && sucursal.promedio !== null && sucursal.promedio < umbral,
                celdas: [
                  sucursal.sucursal,
                  formatearEntero(sucursal.recintos),
                  formatearEntero(sucursal.rondas),
                  formatearPorcentaje(sucursal.promedio),
                  formatearEntero(sucursal.bajoUmbral),
                ],
              }))}
              acciones={
                <DescargarCsv
                  nombre="cumplimiento-por-sucursal"
                  columnas={['Sucursal', 'Recintos', 'Rondas', 'Cumplimiento', 'Bajo umbral']}
                  filas={sucursales.map((sucursal) => [
                    sucursal.sucursal,
                    String(sucursal.recintos),
                    String(sucursal.rondas),
                    sucursal.promedio === null ? '' : String(sucursal.promedio),
                    String(sucursal.bajoUmbral),
                  ])}
                />
              }
            />
          </>
        ) : (
          <Vacio
            titulo="Todavía no hay rondas en este período"
            detalle="No es un error: en las fechas que elegiste no se registró ninguna ronda. Prueba con un período más largo."
          />
        )
      ) : null}
    </Tarjeta>
  );
}

function TarjetaRecintos({
  resultado,
  periodo,
  umbral,
  role,
}: {
  resultado: Resultado<CumplimientoPorRecinto>;
  periodo: string;
  umbral: number | null;
  role: 'ADMIN' | 'SUPERVISOR';
}) {
  const recintos = resultado.estado === 'ok' ? resultado.datos.sites : [];
  const items: BarraItem[] = recintos.map((recinto) => ({
    clave: recinto.siteId,
    titulo: recinto.siteName,
    subtitulo: `${recinto.branchName} · ${plural(recinto.patrols, 'ronda', 'rondas')}`,
    valor: recinto.compliancePct ?? 0,
    etiquetaValor: formatearPorcentaje(recinto.compliancePct),
    alerta: recinto.belowThreshold,
    etiquetaAlerta: 'Bajo el umbral',
  }));
  const columnas = ['Recinto', 'Sucursal', 'Rondas', 'Completadas', 'Incompletas', 'Vencidas', 'Cumplimiento'];
  const filasPlanas = recintos.map((recinto) => [
    recinto.siteName,
    recinto.branchName,
    String(recinto.patrols),
    String(recinto.completed),
    String(recinto.incomplete),
    String(recinto.expired),
    recinto.compliancePct === null ? '' : String(recinto.compliancePct),
  ]);

  return (
    <Tarjeta
      id="informes-recintos"
      eyebrow="Detalle"
      titulo="Cumplimiento por recinto"
      explicacion="El mismo dato abierto recinto por recinto, también de peor a mejor. «Sin dato» significa que hubo rondas pero ninguna cerrada todavía, no que se cumplió cero."
      insignia={recintos.length ? `${recintos.length} recintos` : undefined}
    >
      <Estado resultado={resultado} role={role} />
      {resultado.estado === 'ok' ? (
        recintos.length ? (
          <>
            <BarrasHorizontales
              items={items}
              escala={100}
              referencia={
                umbral === null
                  ? undefined
                  : { valor: umbral, etiqueta: `Umbral ${formatearPorcentaje(umbral)}` }
              }
              ariaLabel={`Cumplimiento por recinto, ${periodo}. ${recintos
                .map(
                  (recinto) =>
                    `${recinto.siteName}, sucursal ${recinto.branchName}: ${formatearPorcentaje(
                      recinto.compliancePct,
                    )}`,
                )
                .join('. ')}.`}
            />
            <ChipsAlerta items={items} />
            <TablaDatos
              titulo={`Cumplimiento por recinto, ${periodo}`}
              columnas={columnas}
              filas={recintos.map((recinto) => ({
                clave: recinto.siteId,
                alerta: recinto.belowThreshold,
                celdas: [
                  recinto.siteName,
                  recinto.branchName,
                  formatearEntero(recinto.patrols),
                  formatearEntero(recinto.completed),
                  formatearEntero(recinto.incomplete),
                  formatearEntero(recinto.expired),
                  formatearPorcentaje(recinto.compliancePct),
                ],
              }))}
              acciones={
                <DescargarCsv
                  nombre="cumplimiento-por-recinto"
                  columnas={columnas}
                  filas={filasPlanas}
                />
              }
            />
          </>
        ) : (
          <Vacio
            titulo="Todavía no hay rondas en este período"
            detalle="La consulta funcionó y no encontró rondas en estas fechas para los recintos visibles."
          />
        )
      ) : null}
    </Tarjeta>
  );
}

function TarjetaEvolucion({
  resultado,
  periodo,
  role,
}: {
  resultado: Resultado<Evolucion>;
  periodo: string;
  role: 'ADMIN' | 'SUPERVISOR';
}) {
  const datos = resultado.estado === 'ok' ? resultado.datos : null;
  const puntos = datos?.points ?? [];
  const conCumplimiento = puntos.filter((punto) => punto.compliancePct !== null);
  const agrupacion: Granularidad = datos?.granularity ?? 'dia';
  const escalaRondas = escalaAgradable(Math.max(...puntos.map((punto) => punto.patrols), 1));

  return (
    <Tarjeta
      id="informes-evolucion"
      eyebrow="Tendencia"
      titulo="Evolución en el tiempo"
      explicacion="Cómo se movió el cumplimiento y cuántas rondas se hicieron. Un tramo cortado en la línea es un período sin rondas cerradas: se deja como hueco a propósito, porque dibujarlo en cero diría algo que no pasó."
      insignia={puntos.length ? `${puntos.length} períodos` : undefined}
    >
      <Estado resultado={resultado} role={role} />
      {datos ? (
        puntos.length ? (
          <>
            <h3 className="stats-subtitulo">Cumplimiento promedio</h3>
            {conCumplimiento.length ? (
              <SerieCumplimiento
                puntos={puntos}
                granularidad={agrupacion}
                umbral={datos.threshold}
                ariaLabel={`Evolución del cumplimiento ${periodo}, agrupada por ${agrupacion}. ${conCumplimiento
                  .map(
                    (punto) =>
                      `${normalizarDia(punto.bucket)}: ${formatearPorcentaje(punto.compliancePct)}`,
                  )
                  .slice(-12)
                  .join('. ')}. Umbral ${formatearPorcentaje(datos.threshold)}.`}
              />
            ) : (
              <Vacio
                titulo="Hay rondas, pero ninguna cerrada todavía"
                detalle="El cumplimiento se calcula al cerrar la ronda. Mientras estén en curso o pendientes no hay porcentaje que graficar."
              />
            )}

            <h3 className="stats-subtitulo">Rondas programadas y completadas</h3>
            <Leyenda
              items={[
                { clave: 'programadas', etiqueta: 'Programadas', tipo: 'pista' },
                { clave: 'completadas', etiqueta: 'Completadas', tipo: 'relleno' },
              ]}
            />
            <ColumnasRondas
              puntos={puntos}
              granularidad={agrupacion}
              ariaLabel={`Rondas programadas y completadas ${periodo}. Máximo de la escala ${formatearEntero(
                escalaRondas,
              )} rondas. ${puntos
                .map(
                  (punto) =>
                    `${normalizarDia(punto.bucket)}: ${formatearEntero(
                      punto.completed,
                    )} de ${formatearEntero(punto.patrols)}`,
                )
                .slice(-12)
                .join('. ')}.`}
            />

            <TablaDatos
              titulo={`Evolución ${periodo}`}
              columnas={['Período', 'Rondas', 'Completadas', 'Recintos', 'Cumplimiento']}
              filas={puntos.map((punto) => ({
                clave: punto.bucket,
                alerta: punto.compliancePct !== null && punto.compliancePct < datos.threshold,
                celdas: [
                  normalizarDia(punto.bucket),
                  formatearEntero(punto.patrols),
                  formatearEntero(punto.completed),
                  formatearEntero(punto.sites),
                  formatearPorcentaje(punto.compliancePct),
                ],
              }))}
              acciones={
                <DescargarCsv
                  nombre="evolucion-cumplimiento"
                  columnas={['Periodo', 'Rondas', 'Completadas', 'Recintos', 'Cumplimiento']}
                  filas={puntos.map((punto) => [
                    normalizarDia(punto.bucket),
                    String(punto.patrols),
                    String(punto.completed),
                    String(punto.sites),
                    punto.compliancePct === null ? '' : String(punto.compliancePct),
                  ])}
                />
              }
            />
          </>
        ) : (
          <Vacio
            titulo="Todavía no hay rondas en este período"
            detalle="No hubo actividad en las fechas elegidas. Prueba con un período más largo o quita el filtro de recinto."
          />
        )
      ) : null}
    </Tarjeta>
  );
}

function TarjetaOmitidos({
  resultado,
  periodo,
  role,
}: {
  resultado: Resultado<PuntosOmitidos>;
  periodo: string;
  role: 'ADMIN' | 'SUPERVISOR';
}) {
  const puntos = resultado.estado === 'ok' ? resultado.datos.checkpoints : [];
  const escala = escalaAgradable(Math.max(...puntos.map((punto) => punto.missed), 1));
  const items: BarraItem[] = puntos.map((punto) => ({
    clave: punto.checkpointId,
    titulo: punto.checkpointName,
    subtitulo: `${punto.siteName} · ${punto.branchName}`,
    valor: punto.missed,
    etiquetaValor: `${formatearEntero(punto.missed)} de ${formatearEntero(
      punto.expected,
    )} (${formatearPorcentaje(punto.missedPct)})`,
  }));
  const columnas = ['Punto', 'Recinto', 'Sucursal', 'Esperado', 'Omitido', '% omisión'];

  return (
    <Tarjeta
      id="informes-omitidos"
      eyebrow="Dónde se rompe"
      titulo="Puntos más omitidos"
      explicacion="Los puntos de control que más veces quedaron sin escanear en rondas ya cerradas. Si uno se repite mes a mes, suele ser la etiqueta despegada o un punto imposible de alcanzar en el tiempo del turno."
      insignia={puntos.length ? `${puntos.length} puntos` : undefined}
    >
      <Estado resultado={resultado} role={role} />
      {resultado.estado === 'ok' ? (
        puntos.length ? (
          <>
            <BarrasHorizontales
              items={items}
              escala={escala}
              ariaLabel={`Puntos de control más omitidos, ${periodo}. ${puntos
                .map(
                  (punto) =>
                    `${punto.checkpointName} en ${punto.siteName}: ${formatearEntero(
                      punto.missed,
                    )} omisiones de ${formatearEntero(punto.expected)} esperadas`,
                )
                .join('. ')}.`}
            />
            <TablaDatos
              titulo={`Puntos más omitidos, ${periodo}`}
              columnas={columnas}
              filas={puntos.map((punto) => ({
                clave: punto.checkpointId,
                celdas: [
                  punto.checkpointName,
                  punto.siteName,
                  punto.branchName,
                  formatearEntero(punto.expected),
                  formatearEntero(punto.missed),
                  formatearPorcentaje(punto.missedPct),
                ],
              }))}
              acciones={
                <DescargarCsv
                  nombre="puntos-mas-omitidos"
                  columnas={columnas}
                  filas={puntos.map((punto) => [
                    punto.checkpointName,
                    punto.siteName,
                    punto.branchName,
                    String(punto.expected),
                    String(punto.missed),
                    String(punto.missedPct),
                  ])}
                />
              }
            />
          </>
        ) : (
          <Vacio
            titulo="No se omitió ningún punto"
            detalle="En este período todas las rondas cerradas pasaron por todos sus puntos. Es la respuesta buena."
          />
        )
      ) : null}
    </Tarjeta>
  );
}

function TarjetaRanking({
  resultado,
  periodo,
  role,
}: {
  resultado: Resultado<RankingGuardias>;
  periodo: string;
  role: 'ADMIN' | 'SUPERVISOR';
}) {
  const guardias = resultado.estado === 'ok' ? resultado.datos.guards : [];
  const umbral = resultado.estado === 'ok' ? resultado.datos.threshold : null;
  const items: BarraItem[] = guardias.map((guardia) => ({
    clave: guardia.guardId,
    titulo: guardia.guardName,
    subtitulo: `${plural(guardia.patrols, 'ronda', 'rondas')} · ${formatearEntero(
      guardia.belowThreshold,
    )} bajo el umbral`,
    valor: guardia.compliancePct ?? 0,
    etiquetaValor: formatearPorcentaje(guardia.compliancePct),
    alerta: umbral !== null && guardia.compliancePct !== null && guardia.compliancePct < umbral,
    etiquetaAlerta: 'Bajo el umbral',
  }));
  const columnas = ['Guardia', 'Rondas', 'Evaluadas', 'Cumplimiento', 'Rondas bajo umbral'];

  return (
    <Tarjeta
      id="informes-guardias"
      eyebrow="Equipo"
      titulo="Ranking de guardias"
      explicacion="Cumplimiento promedio por guardia, de peor a mejor. Sirve para decidir a quién acompañar o reforzar; un promedio bajo con pocas rondas suele ser un turno difícil, no una persona."
      insignia={guardias.length ? `${guardias.length} guardias` : undefined}
    >
      <Estado resultado={resultado} role={role} />
      {resultado.estado === 'ok' ? (
        guardias.length ? (
          <>
            <BarrasHorizontales
              items={items}
              escala={100}
              referencia={
                umbral === null
                  ? undefined
                  : { valor: umbral, etiqueta: `Umbral ${formatearPorcentaje(umbral)}` }
              }
              ariaLabel={`Cumplimiento por guardia, ${periodo}. ${guardias
                .map(
                  (guardia) =>
                    `${guardia.guardName}: ${formatearPorcentaje(
                      guardia.compliancePct,
                    )} en ${formatearEntero(guardia.patrols)} rondas`,
                )
                .join('. ')}.`}
            />
            <ChipsAlerta items={items} />
            <TablaDatos
              titulo={`Ranking de guardias, ${periodo}`}
              columnas={columnas}
              filas={guardias.map((guardia) => ({
                clave: guardia.guardId,
                alerta:
                  umbral !== null &&
                  guardia.compliancePct !== null &&
                  guardia.compliancePct < umbral,
                celdas: [
                  guardia.guardName,
                  formatearEntero(guardia.patrols),
                  formatearEntero(guardia.ratedPatrols),
                  formatearPorcentaje(guardia.compliancePct),
                  formatearEntero(guardia.belowThreshold),
                ],
              }))}
              acciones={
                <DescargarCsv
                  nombre="ranking-de-guardias"
                  columnas={columnas}
                  filas={guardias.map((guardia) => [
                    guardia.guardName,
                    String(guardia.patrols),
                    String(guardia.ratedPatrols),
                    guardia.compliancePct === null ? '' : String(guardia.compliancePct),
                    String(guardia.belowThreshold),
                  ])}
                />
              }
            />
          </>
        ) : (
          <Vacio
            titulo="Todavía no hay rondas cerradas de ningún guardia"
            detalle="El ranking se arma con rondas ya terminadas. Las que están en curso no cuentan hasta cerrarse."
          />
        )
      ) : null}
    </Tarjeta>
  );
}
