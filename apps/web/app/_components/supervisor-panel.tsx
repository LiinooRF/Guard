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
  resolverRangoPanel,
  type ClaveGrafica,
  type CumplimientoPorRecinto,
  type PuntosOmitidos,
} from './stats-charts-data';
import { SupervisorInformes, type OpcionRecintoSupervisor } from './supervisor-informes';
import { SupervisorOmisiones } from './supervisor-omisiones';
import { SupervisorRutas } from './supervisor-rutas';
import {
  TOPE_PUNTOS_OMITIDOS,
  elegirRecinto,
  esUuid,
  leerReglasOmision,
  normalizarUuid,
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

  const [cumplimiento, omitidos, reglasEfectivas] = await Promise.all([
    // El catalogo de recintos sale de aca y no de un `GET /supervisor/sites`,
    // que no existe: esta respuesta ya viene acotada a los recintos asignados.
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
  ]);

  const recintos = cumplimiento.estado === 'ok' ? cumplimiento.datos.sites : [];
  const umbral = cumplimiento.estado === 'ok' ? cumplimiento.datos.threshold : null;
  const reglasOmision =
    reglasEfectivas.estado === 'ok' ? leerReglasOmision(reglasEfectivas.datos.rules) : null;
  const recinto = elegirRecinto(recintos, recintoPedido);

  // Las rondas del recinto elegido. Sin recinto no se pide nada: el endpoint es
  // por recinto y pedirselos todos seria una consulta por cada uno.
  const rondas: ResultadoSupervisor<RondaSupervisor[]> = recinto
    ? await pedir<RondaSupervisor[]>(`/supervisor/sites/${recinto.id}/patrols`)
    : { estado: 'ok', datos: [] };

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

  const opciones: OpcionRecintoSupervisor[] = recintos
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
        {/* La insignia solo se pinta si la consulta respondio. "0 recintos"
            cuando en realidad no pudimos preguntar es una afirmacion falsa.
            Y dice "con rondas" porque eso es lo que cuenta: `compliance-by-site`
            devuelve los recintos CON actividad en el periodo, no los asignados.
            Un supervisor con 5 recintos y 2 con rondas leia "2 recintos". */}
        {cumplimiento.estado === 'ok' ? (
          <span className="status-pill">
            {recintos.length === 1
              ? '1 recinto con rondas'
              : `${recintos.length} recintos con rondas`}
          </span>
        ) : null}
      </div>
      <p className="section-explanation">
        Todo lo de esta sección corresponde únicamente a los recintos que tienes asignados, y usa
        el mismo período que elegiste arriba ({periodo}). Si un recinto no es tuyo, el servidor no
        entrega sus datos: no depende de esta pantalla.
      </p>

      {/* De esta consulta salen el catalogo de recintos y el umbral vigente. Si
          falla, las tarjetas de abajo pierden contexto y hay que decirlo aca
          arriba una vez, en vez de repetirlo en las tres. */}
      <EstadoSupervisor resultado={cumplimiento} />

      <SupervisorOmisiones resultado={omitidos} reglas={reglasOmision} periodo={periodo} />

      <div className="stats-grid">
        <SupervisorRutas resultado={rondas} recinto={recinto} umbral={umbral} />
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
