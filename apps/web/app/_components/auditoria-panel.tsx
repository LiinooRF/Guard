/**
 * Auditoria de acciones del tenant (#104) — panel del ADMIN.
 *
 * Componente de SERVIDOR. Lee la cookie `sentrycore_access` y pide todo por la red
 * interna, igual que `stats-charts.tsx` y `app/app/[role]/page.tsx`. Al
 * navegador no viaja ni un token ni una llamada a la API: llega HTML, y solo la
 * barra de filtros es interactiva.
 *
 * Que resuelve, en palabras del issue: poder reconstruir QUIEN cambio QUE y
 * CUANDO dentro de la empresa. Eso obliga a cuatro cosas que no son adorno:
 *
 * · **La hora se muestra en la zona del recinto**, no en la del servidor ni en
 *   la del navegador de quien mira. Una accion de las 23:40 tiene que decir
 *   23:40, porque el turno de noche es donde pasan las cosas. Y el corte de los
 *   dias del filtro se hace en esa misma zona, sumando el dia al reloj de pared
 *   ANTES de convertirlo a instante (ver `auditoria-datos.ts`).
 * · **Vacio y no-registrado son dos cosas distintas.** Hay acciones que el
 *   producto declara y que ningun servicio escribe todavia. Un listado en
 *   blanco se lee como "nadie hizo nada"; el panel dice cual es cual.
 * · **Solo lectura, y se dice.** La tabla es append-only en PostgreSQL: la API
 *   ni siquiera tiene permiso de UPDATE sobre ella. Que se vea que no hay boton
 *   de editar es parte de lo que hace que esto sirva como prueba.
 * · **Se muestra `actorLabel`, nunca `actorId`.** El id puede apuntar a una
 *   cuenta ya eliminada; la descripcion textual es lo unico que sobrevive.
 *
 * Alcance: `GET /admin/audit` exige `tenant:audit:read`, permiso que hoy solo
 * tiene el ADMIN (`packages/shared/src/permissions.ts`). El SUPERVISOR no llega
 * a este panel, y esta bien que asi sea: la auditoria es de la empresa completa
 * y no se puede recortar a los recintos asignados de nadie, porque la mitad de
 * sus filas —reglas, usuarios— no cuelgan de un recinto. El servidor lo decide
 * igual: esconder la seccion no seria control de acceso.
 */

import Link from 'next/link';
import { cookies } from 'next/headers';

import {
  CATALOGO_ACCIONES,
  COLUMNAS_CSV,
  accionesSinRegistro,
  describirAccion,
  etiquetaEntidad,
  filasCsv,
  filasPorConsulta,
  formatearInstante,
  hoyEnZona,
  opcionesDeAccion,
  opcionesDeActor,
  otrosParametrosDeLaPagina,
  paginadoAtascado,
  parametrosDeAuditoria,
  parametrosDeConsulta,
  parametrosDeUrl,
  referenciaCorta,
  resolverFiltro,
  resolverReglasAuditoria,
  resolverZona,
  resumirAuditoria,
  siguienteCorte,
  type FichaAccion,
  type ParametrosDePagina,
  type RegistroAuditoria,
  type UsuarioAuditable,
} from './auditoria-datos';
import { AuditoriaFiltros } from './auditoria-filtros';
import { DescargarCsv } from './stats-charts-csv';
import { etiquetaRango, formatearEntero, plural } from './stats-charts-data';

type ParametrosUrl = ParametrosDePagina;

/**
 * Texto largo dentro de `.stats-tabla`, que trae `white-space: nowrap`. Sin
 * esto, un resumen de una linea deja la tabla de dos metros de ancho. Va en
 * linea y no en `globals.css` porque ese archivo lo toca otro carril; la clase
 * equivalente esta propuesta en INTEGRACION.md para moverla cuando se pueda.
 */
const CELDA_LARGA = { whiteSpace: 'normal', minWidth: '16rem' } as const;

/**
 * Estado de una consulta. Es un union y no `T | null` para que "no hay
 * acciones", "no tienes permiso" y "se cayo" no se puedan confundir al
 * dibujar. Es la misma decision de `stats-charts.tsx` y por el mismo motivo.
 */
type Resultado<T> =
  | { estado: 'ok'; datos: T }
  | { estado: 'sin-sesion' }
  | { estado: 'sin-permiso' }
  | { estado: 'error' };

function apiPublica() {
  return process.env.NEXT_PUBLIC_API_URL ?? '/api';
}

async function pedir<T>(ruta: string, parametros?: URLSearchParams): Promise<Resultado<T>> {
  const almacen = await cookies();
  const acceso = almacen.get('sentrycore_access');
  if (!acceso) return { estado: 'sin-sesion' };

  const consulta = parametros && [...parametros.keys()].length ? `?${parametros.toString()}` : '';
  try {
    const respuesta = await fetch(
      `${process.env.API_INTERNAL_URL ?? apiPublica()}${ruta}${consulta}`,
      {
        headers: { cookie: `sentrycore_access=${acceso.value}` },
        cache: 'no-store',
      },
    );
    if (respuesta.ok) return { estado: 'ok', datos: (await respuesta.json()) as T };
    if (respuesta.status === 401) return { estado: 'sin-sesion' };
    if (respuesta.status === 403) return { estado: 'sin-permiso' };
    return { estado: 'error' };
  } catch {
    return { estado: 'error' };
  }
}

function datosO<T>(resultado: Resultado<T>, respaldo: T): T {
  return resultado.estado === 'ok' ? resultado.datos : respaldo;
}

export async function AuditoriaPanel({
  searchParams,
  zonaHoraria,
}: {
  /**
   * Los `searchParams` de la pagina. Se aceptan resueltos o como promesa —que
   * es como los entrega Next 15—. Sin esto el panel abre igual, con el periodo
   * por defecto; lo que se pierde son los filtros.
   */
  searchParams?: ParametrosUrl | Promise<ParametrosUrl>;
  /**
   * Zona horaria del recinto (`sites.timezone`). La columna existe y otros
   * endpoints ya la devuelven —`geo/gps-policy.service.ts` y
   * `consent/consent.service.ts`—, pero `GET /admin/sites` no la trae y no hay
   * ninguna zona a nivel de TENANT, que es lo que este panel necesitaria:
   * `audit_log` es de la empresa, no de un recinto. Ver INTEGRACION.md § 5.
   *
   * Sin la prop se cae al `DEFAULT` de esa misma columna. La zona se muestra
   * siempre en pantalla: quien lee tiene que saber de que reloj le hablan.
   */
  zonaHoraria?: string;
}) {
  const parametros: ParametrosUrl = (await searchParams) ?? {};
  /**
   * Lo que ya viaja en la URL y NO es de este panel (el periodo y el recinto de
   * los informes, por ejemplo). Se arrastra en cada enlace que arma el panel:
   * esta pagina la comparten varios bloques y ninguno es dueño de la query.
   */
  const otros = otrosParametrosDeLaPagina(parametros);

  const zona = resolverZona(zonaHoraria);
  const hoy = hoyEnZona(zona);

  // Lo que no depende del filtro va junto. Las reglas primero porque de ellas
  // salen el periodo por defecto y cuantas filas trae cada pagina.
  const [reglasResultado, accionesResultado, usuariosResultado] = await Promise.all([
    pedir<{ rules: Record<string, unknown> }>('/rules/effective'),
    pedir<string[]>('/admin/audit/actions'),
    pedir<UsuarioAuditable[]>('/admin/users'),
  ]);

  const reglas = resolverReglasAuditoria(
    reglasResultado.estado === 'ok' ? reglasResultado.datos.rules : null,
  );
  const filtro = resolverFiltro(parametrosDeAuditoria(parametros), hoy, reglas, zona);

  const registrosResultado = await pedir<RegistroAuditoria[]>(
    '/admin/audit',
    parametrosDeConsulta(filtro, reglas, zona),
  );
  const registros = datosO(registrosResultado, []);

  // La accion del filtro entra a las opciones aunque no este en el catalogo ni
  // en los datos: si no, el <select> no tendria ninguna <option> con ese valor,
  // el navegador mostraria "Todas" y la consulta iria filtrada igual. Un
  // listado vacio bajo un filtro que dice "Todas" se lee como "no pasó nada".
  const acciones = opcionesDeAccion(
    filtro.accion
      ? [...datosO(accionesResultado, []), filtro.accion]
      : datosO(accionesResultado, []),
  );
  const actores = opcionesDeActor(registros, datosO(usuariosResultado, []));
  const resumen = resumirAuditoria(registros);
  const corteSiguiente = siguienteCorte(registros, filtro, reglas);
  const atascado = paginadoAtascado(registros, filtro, reglas);
  const porConsulta = filasPorConsulta(reglas);
  const sinRegistro = accionesSinRegistro();
  const accionElegida = filtro.accion ? describirAccion(filtro.accion) : null;

  /**
   * `true` si lo que se ve es UNA pagina y no el periodo entero. Las cifras de
   * arriba se calculan sobre las filas que llegaron, no sobre el periodo:
   * `GET /admin/audit` no devuelve un total, y sumar paginas contaria dos veces
   * la fila del borde (el corte es inclusivo a proposito). Se dice cual es cual
   * en vez de dar por total lo que no lo es.
   */
  const soloUnaPagina = Boolean(filtro.corte) || corteSiguiente !== null;

  return (
    <section className="stats-seccion" id="auditoria">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Trazabilidad</span>
          <h2>Auditoría de acciones</h2>
        </div>
        <span className="status-pill">Solo lectura</span>
      </div>
      <p className="section-explanation">
        Quién cambió qué y cuándo dentro de la empresa, {etiquetaRango(filtro)}. Las horas están en
        la zona horaria del recinto ({zona}). Este registro no se puede editar ni borrar desde el
        sistema: se acumula.
      </p>

      {filtro.ajustado ? (
        <p className="stats-estado aviso" role="status">
          El filtro que traía el enlace no servía —o pedía más días de los que el panel revisa de
          una vez—, así que se ajustó al que ves arriba.
        </p>
      ) : null}

      <AuditoriaFiltros
        valores={{
          desde: filtro.desde,
          hasta: filtro.hasta,
          usuario: filtro.actorId,
          accion: filtro.accion,
        }}
        actores={actores}
        acciones={acciones}
        hoy={hoy}
        diasMaximos={reglas.diasMaximos}
        diasPorDefecto={reglas.diasPorDefecto}
        /* Los parametros de los otros bloques de la pagina, ya serializados. Se
           mandan desde el servidor —y no se leen con useSearchParams— para no
           obligar a envolver esto en un <Suspense>. */
        otrosParametros={otros.toString()}
      />

      {usuariosResultado.estado !== 'ok' ? (
        <p className="stats-estado aviso" role="status">
          No pudimos cargar la lista de usuarios de la empresa, así que el filtro de usuario solo
          ofrece a quienes aparecen en las acciones de este período.
        </p>
      ) : null}

      {sinRegistro.length ? (
        <p className="stats-estado aviso" role="status">
          <strong>
            {plural(sinRegistro.length, 'acción del producto', 'acciones del producto')} todavía no
            queda{sinRegistro.length === 1 ? '' : 'n'} registrada
            {sinRegistro.length === 1 ? '' : 's'} por el servidor
          </strong>{' '}
          —entre ellas el alta y la baja de usuarios y los cambios de ruta—, así que este listado
          no alcanza todavía para reconstruirlo todo. El detalle está abajo, en «Qué significa cada
          acción».
        </p>
      ) : null}

      <Estado resultado={registrosResultado} />

      {registrosResultado.estado === 'ok' ? (
        <>
          {/* Cifras de LO QUE SE ESTA VIENDO. Cuando hay más de una página se
              dice en el título de cada tarjeta, porque «Acciones registradas:
              100» bajo un encabezado que dice «del X al Y» se lee como el total
              del período, y no lo es. */}
          <div className="stat-grid stats-cifras">
            <article className="stat-card stats-cifra">
              <span>{soloUnaPagina ? 'Acciones en esta página' : 'Acciones registradas'}</span>
              <strong>{formatearEntero(resumen.registros)}</strong>
              <small>
                {soloUnaPagina
                  ? `El período tiene más: cada página trae hasta ${formatearEntero(porConsulta)}`
                  : resumen.masReciente
                    ? `La última, el ${formatearInstante(resumen.masReciente, zona)}`
                    : 'En el período filtrado'}
              </small>
            </article>
            <article className="stat-card stats-cifra">
              <span>Personas involucradas</span>
              <strong>{formatearEntero(resumen.personas)}</strong>
              <small>
                Cuentas que hicieron al menos un cambio
                {soloUnaPagina ? ', en esta página' : ' en el período'}
              </small>
            </article>
            <article className="stat-card stats-cifra">
              <span>Tipos de acción</span>
              <strong>{formatearEntero(resumen.acciones)}</strong>
              <small>Distintos, {soloUnaPagina ? 'en esta página' : 'dentro del período'}</small>
            </article>
          </div>

          {filtro.corte ? (
            <p className="stats-estado aviso" role="status">
              Estás viendo las acciones anteriores a las {formatearInstante(filtro.corte, zona)}. La
              primera línea se repite del listado anterior a propósito: es el borde del corte, y
              preferimos repetir una antes que arriesgarnos a saltarla.{' '}
              <Link
                href={`?${parametrosDeUrl({ ...filtro, corte: '' }, undefined, otros).toString()}#auditoria`}
              >
                Volver al comienzo del período
              </Link>
              .
            </p>
          ) : null}

          {registros.length ? (
            <TablaAuditoria registros={registros} zona={zona} porConsulta={porConsulta} />
          ) : (
            <Vacio accion={accionElegida} conFiltroDeUsuario={Boolean(filtro.actorId)} />
          )}

          {corteSiguiente ? (
            <p className="section-explanation">
              <Link
                className="secondary-button stats-boton"
                href={`?${parametrosDeUrl(filtro, corteSiguiente, otros).toString()}#auditoria`}
              >
                Ver las acciones anteriores a las {formatearInstante(corteSiguiente, zona)}
              </Link>
            </p>
          ) : null}

          {atascado ? (
            <p className="stats-estado aviso" role="status">
              Hay más de {formatearEntero(porConsulta)} acciones registradas en el mismo
              instante, así que no podemos seguir hacia atrás sin arriesgarnos a saltarnos alguna.
              Acorta el período o filtra por usuario o por tipo de acción.
            </p>
          ) : null}
        </>
      ) : null}

      <LeyendaAcciones acciones={acciones} />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Tabla                                                               */
/* ------------------------------------------------------------------ */

function TablaAuditoria({
  registros,
  zona,
  porConsulta,
}: {
  registros: readonly RegistroAuditoria[];
  zona: string;
  /**
   * Cuantas filas se piden de verdad (`min(filasPorPagina, TOPE_FILAS_API)`),
   * no el techo de la API. El pie de la tabla lo dice en voz alta y tiene que
   * ser el numero que se pidio: prometer 500 habiendo pedido 100 es
   * exactamente el dato falso que este panel existe para no dar.
   */
  porConsulta: number;
}) {
  return (
    <div className="stats-detalle-cuerpo">
      <div className="stats-detalle-acciones">
        <DescargarCsv
          nombre="auditoria-de-acciones"
          columnas={[...COLUMNAS_CSV]}
          filas={filasCsv(registros, zona)}
        />
      </div>
      <div className="stats-tabla-envoltura">
        <table className="stats-tabla">
          <caption className="stats-invisible">
            Acciones registradas, de la más reciente a la más antigua. Horas en {zona}.
          </caption>
          <thead>
            <tr>
              <th scope="col">Fecha y hora</th>
              <th scope="col">Usuario</th>
              <th scope="col">Acción</th>
              <th scope="col">Sobre qué</th>
              <th scope="col">Detalle</th>
            </tr>
          </thead>
          <tbody>
            {registros.map((registro) => {
              const ficha = describirAccion(registro.action);
              return (
                <tr key={registro.id}>
                  <th scope="row">{formatearInstante(registro.createdAt, zona)}</th>
                  {/* actorLabel y no actorId: la cuenta puede ya no existir. */}
                  <td>{registro.actorLabel}</td>
                  <td>{ficha.etiqueta}</td>
                  <td>
                    {etiquetaEntidad(registro.entityType)}
                    {registro.entityId ? (
                      <>
                        {' · '}
                        <small title={registro.entityId}>{referenciaCorta(registro.entityId)}</small>
                      </>
                    ) : null}
                  </td>
                  <td style={CELDA_LARGA}>{registro.summary ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="section-explanation">
        Se muestran hasta {formatearEntero(porConsulta)} acciones por consulta, de la más
        reciente a la más antigua. Descarga el CSV si necesitas adjuntar el registro a algo.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Leyenda                                                             */
/* ------------------------------------------------------------------ */

/**
 * Que significa cada accion y si el servidor la escribe.
 *
 * Va cerrado y al final: no es lo que se viene a mirar. Pero tiene que estar,
 * porque un codigo como `punto.modificado` no le dice nada a quien lee, y
 * porque el estado del registro es justamente lo que impide leer un listado
 * vacio como una tranquilidad.
 */
function LeyendaAcciones({ acciones }: { acciones: readonly FichaAccion[] }) {
  const conocidas = acciones.filter((ficha) =>
    CATALOGO_ACCIONES.some((declarada) => declarada.codigo === ficha.codigo),
  );
  const nuevas = acciones.filter(
    (ficha) => !CATALOGO_ACCIONES.some((declarada) => declarada.codigo === ficha.codigo),
  );

  return (
    <details className="stats-detalle">
      <summary>Qué significa cada acción y cuál queda registrada</summary>
      <div className="stats-detalle-cuerpo">
        <p className="section-explanation">
          «Sin registro» y «parcial» no son fallas de este panel: son acciones que el producto
          declara y que el servidor todavía no escribe. Si buscas una de ellas y no aparece nada,
          es por eso y no porque no haya ocurrido.
        </p>
        <div className="stats-tabla-envoltura">
          <table className="stats-tabla">
            <caption className="stats-invisible">
              Acciones de auditoría, su significado y si el servidor las registra hoy
            </caption>
            <thead>
              <tr>
                <th scope="col">Acción</th>
                <th scope="col">Código</th>
                <th scope="col">Registro</th>
                <th scope="col">Qué significa</th>
              </tr>
            </thead>
            <tbody>
              {[...conocidas, ...nuevas].map((ficha) => (
                <tr key={ficha.codigo} className={ficha.registro === 'ausente' ? 'alerta' : ''}>
                  <th scope="row">{ficha.etiqueta}</th>
                  <td>
                    <small>{ficha.codigo}</small>
                  </td>
                  <td>
                    {ficha.registro === 'completo' ? (
                      'Sí'
                    ) : (
                      <span className="stats-chip alerta">
                        {ficha.registro === 'parcial' ? 'Parcial' : 'No'}
                      </span>
                    )}
                  </td>
                  <td style={CELDA_LARGA}>
                    {ficha.descripcion}
                    {ficha.nota ? ` ${ficha.nota}` : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

/* ------------------------------------------------------------------ */
/* Estados                                                             */
/* ------------------------------------------------------------------ */

function Estado({ resultado }: { resultado: Resultado<unknown> }) {
  if (resultado.estado === 'ok') return null;

  if (resultado.estado === 'sin-permiso') {
    return (
      <p className="stats-estado aviso" role="status">
        <strong>No tienes acceso a la auditoría de esta empresa.</strong> La revisan los
        administradores. Si necesitas verla, pídele a uno que te dé ese acceso.
      </p>
    );
  }

  if (resultado.estado === 'sin-sesion') {
    return (
      <p className="stats-estado error" role="alert">
        <strong>Tu sesión venció.</strong> Vuelve a entrar para revisar la auditoría.
      </p>
    );
  }

  return (
    <p className="stats-estado error" role="alert">
      <strong>No pudimos cargar la auditoría.</strong> Esto no significa que no haya acciones
      registradas: significa que no logramos consultarlas. Actualiza la página en un momento más.
    </p>
  );
}

/**
 * Vacio de verdad: la consulta funciono y no encontro nada. El texto cambia
 * segun el filtro, porque "no se registro nada" y "el sistema todavia no anota
 * esto" son dos respuestas distintas y solo una es tranquilizadora.
 */
function Vacio({
  accion,
  conFiltroDeUsuario,
}: {
  accion: FichaAccion | null;
  conFiltroDeUsuario: boolean;
}) {
  if (accion && accion.registro !== 'completo' && accion.nota) {
    return (
      <div className="dashboard-empty stats-vacio">
        <strong>
          {accion.registro === 'parcial'
            ? 'Esta acción se registra solo a medias'
            : 'Esta acción todavía no se registra'}
        </strong>
        <span>
          {accion.nota} Que no aparezca nada no quiere decir que no haya pasado: quiere decir que el
          sistema aún no lo anota.
        </span>
      </div>
    );
  }

  return (
    <div className="dashboard-empty stats-vacio">
      <strong>No hay acciones registradas con este filtro</strong>
      <span>
        La consulta funcionó y no encontró nada
        {conFiltroDeUsuario ? ' para ese usuario' : ''} en el período elegido. Prueba con un período
        más largo o quita algún filtro.
      </span>
    </div>
  );
}
