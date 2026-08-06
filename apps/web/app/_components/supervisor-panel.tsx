/**
 * Panel de estadisticas e informes del SUPERVISOR (#99).
 *
 * Componente de SERVIDOR. Lee la cookie `voxia_access` y pide todo por la red
 * interna, igual que `app/app/[role]/page.tsx` y que el panel de informes (#87):
 * al navegador no viaja ni un token, ni una llamada a la API, ni una libreria de
 * graficos. Llega HTML con SVG dentro. El unico JavaScript de esta pantalla es
 * el que ya existia: la barra de filtros y el boton de descargar CSV.
 *
 * **No pinta su propia barra de filtros.** Reusa la de `StatsCharts` leyendo los
 * mismos parametros de la URL (`?desde=&hasta=&recinto=&sucursal=`). Dos filas
 * de filtros en la misma pantalla, cada una con su periodo, es la forma segura
 * de que alguien compare dos cortes distintos creyendo que son el mismo. Por eso
 * este panel va DESPUES de `StatsCharts` en la pagina.
 *
 * El alcance no se decide aca: los tres endpoints que se consultan ya limitan
 * al supervisor a sus recintos asignados (`supervisor_sites`), y el de rondas
 * responde 403 si el recinto no es suyo. Esta pantalla solo se encarga de no
 * inventar nombres ni tratar ese 403 como una falla.
 */

import { cookies } from 'next/headers';

import {
  TOPE_DIAS,
  etiquetaRango,
  hoyUtc,
  plural,
  resolverRangoPanel,
  type ClaveGrafica,
  type CumplimientoPorRecinto,
  type CumplimientoPorRuta,
  type PuntosOmitidos,
} from './stats-charts-data';
import { SupervisorInformes, type OpcionRecintoSupervisor } from './supervisor-informes';
import { SupervisorOmisiones } from './supervisor-omisiones';
import { SupervisorRutas } from './supervisor-rutas';
import {
  TOPE_PUNTOS_OMITIDOS,
  TOPE_RUTAS,
  elegirRecinto,
  esUuid,
  leerReglasOmision,
  normalizarUuid,
  type RecintoAsignado,
  type RecintoDelCatalogo,
  type ResultadoSupervisor,
  type RondaSupervisor,
} from './supervisor-datos';
import { EstadoSupervisor } from './supervisor-tarjeta';

type ParametrosUrl = Record<string, string | string[] | undefined>;

function apiPublica() {
  return process.env.NEXT_PUBLIC_API_URL ?? '/api';
}

async function pedir<T>(ruta: string, parametros?: URLSearchParams): Promise<ResultadoSupervisor<T>> {
  const almacen = await cookies();
  const acceso = almacen.get('voxia_access');
  if (!acceso) return { estado: 'sin-sesion' };

  const consulta = parametros?.toString();
  try {
    const respuesta = await fetch(
      `${process.env.API_INTERNAL_URL ?? apiPublica()}${ruta}${consulta ? `?${consulta}` : ''}`,
      {
        headers: { cookie: `voxia_access=${acceso.value}` },
        cache: 'no-store',
      },
    );
    if (respuesta.ok) return { estado: 'ok', datos: (await respuesta.json()) as T };
    // 403 es el alcance por recinto funcionando, no una falla del panel.
    if (respuesta.status === 403) return { estado: 'sin-permiso' };
    if (respuesta.status === 400) {
      const cuerpo = (await respuesta.json().catch(() => null)) as {
        message?: string | string[];
      } | null;
      const mensaje = Array.isArray(cuerpo?.message) ? cuerpo?.message.join('. ') : cuerpo?.message;
      return { estado: 'rango-rechazado', mensaje: mensaje ?? 'El período pedido no es válido.' };
    }
    return { estado: 'error' };
  } catch {
    return { estado: 'error' };
  }
}

export async function SupervisorPanel({
  searchParams,
}: {
  /**
   * Los `searchParams` de la pagina. Se aceptan resueltos o como promesa —que es
   * como los entrega Next 15— para que engancharlo sea una linea. Sin esto el
   * panel abre igual con el ultimo mes; lo que se pierde son los filtros.
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

  const comunes = () => {
    const busqueda = new URLSearchParams({ from: rango.desde, to: rango.hasta });
    // Un recinto de la URL que no tenga forma de UUID ni se manda: el DTO lo
    // rechazaria con un 400 que no le dice nada a nadie. Y se manda normalizado
    // a minusculas, que es como devuelve los uuid la API: asi el id que se
    // compara con la respuesta es el mismo texto.
    if (recintoPedido && esUuid(recintoPedido)) {
      busqueda.set('siteId', normalizarUuid(recintoPedido));
    }
    if (sucursalPedida) busqueda.set('branchName', sucursalPedida);
    return busqueda;
  };

  const omitidosParams = comunes();
  omitidosParams.set('limit', String(TOPE_PUNTOS_OMITIDOS));

  const claveOmitidos: ClaveGrafica = 'omitidos';
  const dentroDeTopeOmitidos = rango.dias <= TOPE_DIAS[claveOmitidos];

  const [cumplimiento, omitidos, reglasEfectivas, asignados] = await Promise.all([
    pedir<CumplimientoPorRecinto>('/stats/charts/compliance-by-site', comunes()),
    dentroDeTopeOmitidos
      ? pedir<PuntosOmitidos>('/stats/charts/missed-checkpoints', omitidosParams)
      : Promise.resolve<ResultadoSupervisor<PuntosOmitidos>>({
          estado: 'fuera-de-tope',
          clave: claveOmitidos,
        }),
    // Sin `siteId`: las dos reglas de omision cronica se configuran a nivel de
    // plataforma o de empresa (ver su ficha de catalogo), justamente porque esta
    // tarjeta compara puntos de varios recintos a la vez.
    pedir<{ rules?: unknown }>('/rules/effective'),
    /*
     * El catalogo de recintos para elegir. Sale de aca y NO de
     * `compliance-by-site`, que solo devuelve los recintos que tuvieron rondas
     * en el periodo: con esa fuente, un supervisor con cinco recintos asignados
     * y dos con actividad no podia ni siquiera SELECCIONAR los otros tres para
     * ver sus informes, que es justo lo que pide el issue. El servidor ya lo
     * acota a `supervisor_sites`, igual que todo lo demas de esta pantalla.
     */
    pedir<RecintoAsignado[]>('/supervisor/sites'),
  ]);

  const conRondas = cumplimiento.estado === 'ok' ? cumplimiento.datos.sites : [];

  /*
   * Aca ya no se lee ningun umbral. El de la tarjeta de rutas viaja DENTRO de
   * `compliance-by-route`, que es la misma respuesta con la que el servidor
   * conto `belowThreshold`. Cuando salia de esta consulta, un fallo de
   * `compliance-by-site` dejaba la tarjeta de rutas sin umbral: seguia
   * dibujandose, pero sin marcar ninguna ruta bajo la linea y sin decir por que.
   */

  const reglasOmision =
    reglasEfectivas.estado === 'ok' ? leerReglasOmision(reglasEfectivas.datos.rules) : null;

  /*
   * El catalogo con el que se elige recinto y se pintan los nombres.
   *
   * Si `/supervisor/sites` respondio, son TODOS los recintos asignados; si esa
   * llamada fallo, se cae a los que tuvieron rondas, que es lo que habia antes.
   * Peor catalogo, pero un catalogo: quedarse sin selector porque una de dos
   * consultas fallo deja la pantalla inservible.
   *
   * Cuando el filtro de arriba trae sucursal, el catalogo se recorta igual que
   * lo hace el servidor con las cifras. Sin esto la lista ofreceria recintos de
   * otra sucursal mientras las graficas muestran solo una: dos alcances
   * distintos en la misma pantalla.
   */
  const catalogo: RecintoDelCatalogo[] =
    asignados.estado === 'ok'
      ? asignados.datos
          .filter((sitio) => !sucursalPedida || sitio.branchName === sucursalPedida)
          .map((sitio) => ({
            siteId: sitio.id,
            siteName: sitio.name,
            branchName: sitio.branchName,
          }))
      : conRondas.map((sitio) => ({
          siteId: sitio.siteId,
          siteName: sitio.siteName,
          branchName: sitio.branchName,
        }));

  const recinto = elegirRecinto(catalogo, recintoPedido);

  /*
   * Lo del recinto elegido. Sin recinto no se pide nada: las rondas se piden por
   * recinto —pedirselas a todos seria una consulta por cada uno— y las rutas de
   * dos recintos distintos no se comparan entre si.
   *
   * El `siteId` de las rutas sale del recinto YA resuelto y no de la URL: puede
   * venir de `elegirRecinto()` cuando el supervisor tiene uno solo asignado y no
   * eligio nada. Si el id no fuera suyo, el servidor responde 403 y eso se
   * dibuja como "ese recinto no esta entre los tuyos", no como una falla.
   */
  const claveRutas: ClaveGrafica = 'rutas';
  const dentroDeTopeRutas = rango.dias <= TOPE_DIAS[claveRutas];

  const rutasParams = new URLSearchParams({
    from: rango.desde,
    to: rango.hasta,
    limit: String(TOPE_RUTAS),
  });
  if (recinto) rutasParams.set('siteId', normalizarUuid(recinto.id));

  const [rondas, rutas] = await Promise.all([
    recinto
      ? pedir<RondaSupervisor[]>(`/supervisor/sites/${recinto.id}/patrols`)
      : Promise.resolve<ResultadoSupervisor<RondaSupervisor[]>>({ estado: 'ok', datos: [] }),
    recinto && dentroDeTopeRutas
      ? pedir<CumplimientoPorRuta>('/stats/charts/compliance-by-route', rutasParams)
      : Promise.resolve<ResultadoSupervisor<CumplimientoPorRuta>>(
          recinto
            ? { estado: 'fuera-de-tope', clave: claveRutas }
            : { estado: 'ok', datos: { range: rango, threshold: 0, routes: [] } },
        ),
  ]);

  /*
   * Los parametros tal como venian en la URL, aplanados. Los enlaces de la
   * tarjeta de informes parten de aca en vez de armarse desde cero: `agrupacion`
   * la lee StatsCharts en esta misma pantalla, y elegir un recinto no tiene por
   * que resetear la granularidad de la grafica de arriba.
   */
  const actuales: Record<string, string> = {};
  for (const clave of Object.keys(parametros)) {
    const valor = texto(clave);
    if (valor) actuales[clave] = valor;
  }

  const opciones: OpcionRecintoSupervisor[] = catalogo
    .map((item) => ({ id: item.siteId, nombre: item.siteName, sucursal: item.branchName }))
    .sort((a, b) => `${a.sucursal} ${a.nombre}`.localeCompare(`${b.sucursal} ${b.nombre}`, 'es'));

  const periodo = etiquetaRango(rango);

  return (
    <section className="stats-seccion" id="supervisor">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Mis recintos</span>
          <h2>Revisión de rondas e informes</h2>
        </div>
        {/* La insignia solo se pinta si la consulta respondio: "0 recintos"
            cuando en realidad no pudimos preguntar es una afirmacion falsa.
            Y cada fuente se nombra por lo que es. `/supervisor/sites` devuelve
            los recintos ASIGNADOS; `compliance-by-site`, solo los que tuvieron
            rondas en el periodo. Cuando hay que caer en el segundo, la insignia
            dice "con rondas" en vez de mentir: un supervisor con 5 recintos y 2
            con actividad leia "2 recintos". */}
        {asignados.estado === 'ok' ? (
          <span className="status-pill">
            {plural(catalogo.length, 'recinto asignado', 'recintos asignados')}
          </span>
        ) : cumplimiento.estado === 'ok' ? (
          <span className="status-pill">
            {plural(conRondas.length, 'recinto con rondas', 'recintos con rondas')}
          </span>
        ) : null}
      </div>
      <p className="section-explanation">
        Todo lo de esta sección corresponde únicamente a los recintos que tienes asignados, y usa
        el mismo período que elegiste arriba ({periodo}). Si un recinto no es tuyo, el servidor no
        entrega sus datos: no depende de esta pantalla.
      </p>

      {/* De esta consulta salen las cifras del periodo y el umbral vigente. Si
          falla, las tarjetas de abajo pierden contexto y hay que decirlo aca
          arriba una vez, en vez de repetirlo en las tres. */}
      <EstadoSupervisor resultado={cumplimiento} />

      {/* El catalogo de recintos es la otra consulta que sostiene la seccion, y
          su falla se ve distinta: no faltan cifras, falta poder ELEGIR. Callarlo
          dejaria una lista corta que se lee como "estos son mis recintos". */}
      {asignados.estado !== 'ok' ? (
        <p className="stats-estado aviso" role="status">
          <strong>La lista de recintos puede estar incompleta.</strong> No pudimos consultar tus
          recintos asignados, así que abajo solo aparecen los que tuvieron rondas en el período.
          Actualiza la página en un momento más; mientras tanto, un recinto que no esté en la lista
          se puede abrir igual con su enlace.
        </p>
      ) : null}

      <SupervisorOmisiones resultado={omitidos} reglas={reglasOmision} periodo={periodo} />

      <div className="stats-grid">
        <SupervisorRutas resultado={rutas} recinto={recinto} />
        <SupervisorInformes
          resultado={rondas}
          recinto={recinto}
          recintos={opciones}
          rango={{ desde: rango.desde, hasta: rango.hasta, sucursal: sucursalPedida }}
          parametrosUrl={actuales}
          apiUrl={apiPublica()}
        />
      </div>
    </section>
  );
}
