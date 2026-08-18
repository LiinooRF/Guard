/**
 * Vista de envios de correo para soporte (#221) — panel del ADMIN.
 *
 * Componente de SERVIDOR. Lee la cookie `sentrycore_access` y pide todo por la red
 * interna, igual que `auditoria-panel.tsx` y `app/app/[role]/page.tsx`. Al
 * navegador no viaja ni un token ni una llamada a la API: llega HTML, y solo la
 * barra de filtros es interactiva.
 *
 * QUE RESPONDE, en la pregunta con la que llama el jefe de operaciones:
 * «¿le llegó el informe al cliente?». Y las tres respuestas distintas que ese
 * «sí» esconde —se encoló, salió de nuestro servidor, el proveedor confirmó que
 * entró al buzón— separadas en pantalla, porque confundirlas es exactamente lo
 * que hace que soporte prometa lo que no puede.
 *
 * CUATRO COSAS QUE NO SON ADORNO
 *
 * · **El motivo del rebote se traduce.** Soporte tiene que leer «la dirección no
 *   existe» y qué hacer al respecto, no `550 5.1.1`. El texto crudo del servidor
 *   sigue disponible, plegado, para cuando hay que escalarlo. La traduccion vive
 *   en `envios-datos.ts` y esta probada con Jest.
 * · **«Salió» y «Llegó» no son lo mismo, y se dicen distinto.** Que el relay
 *   SMTP acepte el mensaje solo dice que se hizo cargo de intentarlo.
 * · **Es dato personal.** Se muestran correos de personas: van en la pantalla,
 *   nunca en la URL —que se pega en tickets— y este componente no escribe una
 *   sola linea de log. Tampoco hay descarga en CSV: ver el registro en pantalla
 *   con permiso de auditoria es una cosa, y dejar un archivo con las direcciones
 *   de los clientes dando vueltas en la carpeta de descargas es otra.
 * · **Solo lectura, y se dice.** No hay «reenviar» ni «marcar como entregado»:
 *   el estado lo escriben la cola y el proveedor. Un boton que deje escribirlo a
 *   mano convierte la bitacora en una opinion. La API tampoco los ofrece.
 *
 * ALCANCE: `GET /notif/envios` exige `tenant:audit:read`, permiso que hoy solo
 * tiene el ADMIN (`packages/shared/src/permissions.ts`), y el listado incluye
 * invitaciones y recuperaciones de clave de toda la empresa. El SUPERVISOR no
 * llega, y esta bien: le mostraria a que correos se invito a gente de recintos
 * que no supervisa. Esconder la seccion no seria control de acceso —lo decide el
 * servidor—, pero montarla igual seria prometerle algo que va a responder 403.
 */

import Link from 'next/link';
import { cookies } from 'next/headers';

import { formatearInstante, hoyEnZona, resolverZona } from './auditoria-datos';
import {
  CATALOGO_ESTADOS,
  ESTADOS_ENVIO,
  describirEstado,
  describirPlantilla,
  explicarMotivo,
  faltaConfirmacionDeEntrega,
  opcionesDePlantilla,
  parametrosAjenos,
  parametrosDeConsulta,
  parametrosDeUrl,
  plantillasPresentes,
  puedeHaberMas,
  recintoPedido,
  referenciaCorta,
  resolverFiltro,
  resumirEnvios,
  siguienteTamano,
  zonaDelRecinto,
  type EnvioRegistrado,
  type EnviosDeRonda,
  type FiltroEnvios,
  type ParametrosDePagina,
  type RecintoConocido,
  type RondaConocida,
} from './envios-datos';
import { EnviosFiltros } from './envios-filtros';
import { formatearEntero, plural } from './stats-charts-data';

/**
 * Texto largo dentro de `.stats-tabla`, que trae `white-space: nowrap`. Sin
 * esto, una explicacion de dos lineas deja la tabla de dos metros de ancho. Va
 * en linea y no en `globals.css` porque ese archivo lo tocan varios carriles;
 * es la misma solucion que ya usa `auditoria-panel.tsx`.
 */
const CELDA_LARGA = { whiteSpace: 'normal', minWidth: '18rem' } as const;

/**
 * Estado de una consulta. Es un union y no `T | null` para que «no hay envios»,
 * «no tienes permiso» y «se cayo» no se puedan confundir al dibujar. Misma
 * decision que `auditoria-panel.tsx` y `stats-charts.tsx`.
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

/**
 * Las filas, vengan del listado o de una ronda.
 *
 * Son dos endpoints con dos formas distintas: `GET /notif/envios` devuelve el
 * arreglo pelado y `GET /notif/rondas/:id/envios` lo devuelve dentro de
 * `{ patrolId, envios }`. Se comprueba la forma en vez de confiar en el tipo:
 * esto es JSON de la red, y el tipo solo describe lo que se espera.
 */
function filasDe(datos: EnvioRegistrado[] | EnviosDeRonda): EnvioRegistrado[] {
  if (Array.isArray(datos)) return datos;
  return Array.isArray(datos.envios) ? datos.envios : [];
}

export async function EnviosPanel({
  searchParams,
  recintos = [],
  rondas = [],
  zonaHoraria,
}: {
  /**
   * Los `searchParams` de la pagina. Se aceptan resueltos o como promesa —que es
   * como los entrega Next 15—. Sin esto el panel abre igual, con lo ultimo
   * enviado; lo que se pierde son los filtros.
   */
  searchParams?: ParametrosDePagina | Promise<ParametrosDePagina>;
  /**
   * Los recintos de la empresa (`GET /admin/sites`), que la pagina ya carga para
   * el ADMIN. Llegan como prop y no se vuelven a pedir: la misma consulta dos
   * veces en el mismo render es latencia regalada.
   */
  recintos?: readonly RecintoConocido[];
  /**
   * Las rondas visibles (`overview.patrols` de `GET /dashboard/tenant`), que la
   * pagina ya carga para las tarjetas y los informes. Son POCAS —esa consulta
   * cierra con `LIMIT 5`— y por eso el selector acepta ademas la ronda que traiga
   * el enlace aunque no este en la lista.
   */
  rondas?: readonly RondaConocida[];
  /** Zona de respaldo cuando no hay recinto elegido. Ver `zona` mas abajo. */
  zonaHoraria?: string;
}) {
  const parametros: ParametrosDePagina = (await searchParams) ?? {};
  /**
   * Lo que ya viaja en la URL y NO es de este panel (el periodo de los informes,
   * los filtros de la auditoria). Se arrastra en cada enlace que arma el panel:
   * esta pagina la comparten varios bloques y ninguno es dueño de la query.
   */
  const otros = parametrosAjenos(parametros);

  /**
   * La zona en la que se leen las horas y se cortan los dias.
   *
   * Sale del recinto elegido (`sites.timezone`), que es la unica correcta: es la
   * misma que usa `RegistroEnviosService.listar()` para interpretar el rango. Sin
   * recinto —o con una ronda elegida, que no dice de que recinto es— se cae a la
   * de respaldo, que es el DEFAULT de esa misma columna. La zona se muestra
   * siempre en pantalla: quien lee tiene que saber de que reloj le hablan.
   */
  const zona = resolverZona(zonaDelRecinto(recintos, recintoPedido(parametros)) ?? zonaHoraria);
  const hoy = hoyEnZona(zona);
  const filtro = resolverFiltro(parametros, hoy);

  const resultado = filtro.ronda
    ? await pedir<EnviosDeRonda>(`/notif/rondas/${filtro.ronda}/envios`)
    : await pedir<EnvioRegistrado[]>('/notif/envios', parametrosDeConsulta(filtro));

  const envios = resultado.estado === 'ok' ? filasDe(resultado.datos) : [];

  const resumen = resumirEnvios(envios);
  // El catalogo MAS lo que aparece en los datos MAS lo que pide el filtro: si la
  // plantilla elegida no tuviera <option>, el navegador mostraria «Todos» con la
  // consulta filtrada igual, y un listado vacio bajo un filtro que dice «Todos»
  // se lee como «no se envió nada».
  const plantillas = opcionesDePlantilla(
    filtro.plantilla ? [...plantillasPresentes(envios), filtro.plantilla] : plantillasPresentes(envios),
  );
  const hayMas = !filtro.ronda && puedeHaberMas(envios, filtro);
  const masFilas = siguienteTamano(filtro.filas);

  return (
    <section className="stats-seccion" id="envios">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Soporte</span>
          <h2>Envíos de correo</h2>
        </div>
        <span className="status-pill">Solo lectura</span>
      </div>
      {/* La zona se nombra SIEMPRE, y se dice de donde sale. Sin recinto
          elegido no es «la del recinto»: es la de respaldo, y quien lee una
          hora tiene derecho a saber de que reloj le estan hablando. */}
      <p className="section-explanation">
        Qué correos envió el sistema, a quién y en qué quedaron.{' '}
        {filtro.recinto
          ? `Las horas están en la zona horaria del recinto (${zona}).`
          : `Las horas están en ${zona}; elige un recinto para verlas en la suya.`}{' '}
        Este registro no se puede editar ni reenviar desde acá: lo escriben la cola de correo y el
        proveedor.
      </p>

      {filtro.ajustado ? (
        <p className="stats-estado aviso" role="status">
          El filtro que traía el enlace no servía, así que se ajustó al que ves arriba.
        </p>
      ) : null}

      {filtro.fechasIgnoradas ? (
        <p className="stats-estado aviso" role="status">
          Se ignoraron las fechas del enlace porque no venía el recinto. El período se lee en la
          zona horaria del recinto, así que sin recinto no hay reloj con el cual cortar los días.
        </p>
      ) : null}

      <EnviosFiltros
        valores={{
          recinto: filtro.recinto,
          estado: filtro.estado,
          plantilla: filtro.plantilla,
          desde: filtro.desde,
          hasta: filtro.hasta,
          ronda: filtro.ronda,
          filas: filtro.filas,
        }}
        recintos={recintos}
        plantillas={plantillas}
        rondas={rondas}
        hoy={hoy}
        /* Los parametros de los otros bloques de la pagina, ya serializados. Se
           mandan desde el servidor —y no se leen con useSearchParams— para no
           obligar a envolver esto en un <Suspense>. */
        otrosParametros={otros.toString()}
      />

      <Estado resultado={resultado} />

      {resultado.estado === 'ok' ? (
        <>
          <div className="stat-grid stats-cifras">
            <article className="stat-card stats-cifra">
              <span>Correos en pantalla</span>
              <strong>{formatearEntero(resumen.total)}</strong>
              <small>
                {resumen.ultimo
                  ? `El último se encoló el ${formatearInstante(resumen.ultimo, zona)}`
                  : 'Con el filtro actual'}
              </small>
            </article>
            <article className="stat-card stats-cifra">
              <span>Confirmados en el buzón</span>
              <strong>{formatearEntero(resumen.entregados)}</strong>
              <small>El proveedor confirmó la entrega</small>
            </article>
            <article className="stat-card stats-cifra">
              <span>Salieron, sin confirmar</span>
              <strong>{formatearEntero(resumen.sinConfirmar)}</strong>
              <small>Aceptados por el servidor del destinatario</small>
            </article>
            <article
              className={`stat-card stats-cifra${resumen.noLlegaron > 0 ? ' alerta' : ''}`}
            >
              <span>No llegaron</span>
              <strong>{formatearEntero(resumen.noLlegaron)}</strong>
              <small>
                {resumen.enCola > 0
                  ? `${plural(resumen.enCola, 'correo sigue', 'correos siguen')} en cola`
                  : 'Rebotes y reintentos agotados'}
              </small>
            </article>
          </div>

          {faltaConfirmacionDeEntrega(resumen) ? (
            <p className="stats-estado aviso" role="status">
              <strong>De lo que ves, nada tiene confirmación de entrega todavía.</strong> Esa
              confirmación la reporta el proveedor de correo por webhook; hasta que llegue, lo más
              honesto que se puede decir de un correo es que <em>salió</em>. Si esto se mantiene en
              todos los envíos durante días, avisa al equipo técnico: probablemente el proveedor no
              está reportando.
            </p>
          ) : null}

          {envios.length ? (
            <TablaEnvios envios={envios} zona={zona} />
          ) : (
            <Vacio filtro={filtro} />
          )}

          {hayMas && masFilas !== null ? (
            <p className="section-explanation">
              <Link
                className="secondary-button stats-boton"
                href={`?${parametrosDeUrl({ ...filtro, filas: masFilas }, otros).toString()}#envios`}
              >
                Ver hasta {formatearEntero(masFilas)} correos
              </Link>{' '}
              Se están mostrando los {formatearEntero(filtro.filas)} más recientes que calzan con el
              filtro, y puede haber más atrás.
            </p>
          ) : null}

          {hayMas && masFilas === null ? (
            <p className="stats-estado aviso" role="status">
              Se están mostrando los {formatearEntero(filtro.filas)} correos más recientes, que es el
              máximo por consulta. Acorta el período o filtra por tipo de correo para ver el resto.
            </p>
          ) : null}
        </>
      ) : null}

      <LeyendaEstados />
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Tabla                                                               */
/* ------------------------------------------------------------------ */

function TablaEnvios({ envios, zona }: { envios: readonly EnvioRegistrado[]; zona: string }) {
  return (
    <div className="stats-detalle-cuerpo">
      <div className="stats-tabla-envoltura">
        <table className="stats-tabla">
          <caption className="stats-invisible">
            Correos enviados, del más reciente al más antiguo. Horas en {zona}.
          </caption>
          <thead>
            <tr>
              <th scope="col">Fecha y hora</th>
              <th scope="col">Tipo de correo</th>
              <th scope="col">Destinatario</th>
              <th scope="col">Estado</th>
              <th scope="col">Qué pasó</th>
            </tr>
          </thead>
          <tbody>
            {envios.map((envio) => {
              const ficha = describirEstado(envio.estado);
              const plantilla = describirPlantilla(envio.plantilla);
              const motivo = explicarMotivo(envio.estado, envio.ultimoError);
              return (
                <tr key={envio.id} className={ficha.tono === 'alerta' ? 'alerta' : ''}>
                  {/* Arriba, cuando se encolo; abajo, en que terminó. Son dos
                      instantes distintos y la diferencia entre los dos es lo que
                      contesta «cuánto se demoró en llegar». */}
                  <th scope="row">
                    {formatearInstante(envio.encoladoEn, zona)}
                    {envio.entregadoEn ? (
                      <>
                        <br />
                        <small>Llegó el {formatearInstante(envio.entregadoEn, zona)}</small>
                      </>
                    ) : envio.falladoEn ? (
                      <>
                        <br />
                        <small>
                          {ficha.etiqueta} el {formatearInstante(envio.falladoEn, zona)}
                        </small>
                      </>
                    ) : envio.enviadoEn ? (
                      <>
                        <br />
                        <small>Salió el {formatearInstante(envio.enviadoEn, zona)}</small>
                      </>
                    ) : null}
                  </th>
                  <td>
                    {plantilla.etiqueta}
                    {envio.patrolId ? (
                      <>
                        <br />
                        <small title={envio.patrolId}>
                          Ronda {referenciaCorta(envio.patrolId)}
                        </small>
                      </>
                    ) : null}
                  </td>
                  {/* El correo se muestra: es lo que soporte necesita comprobar
                      contra la ficha del cliente. No viaja en la URL ni se
                      escribe en ningun log. */}
                  <td>{envio.destinatario}</td>
                  <td>
                    <EstadoChip tono={ficha.tono} etiqueta={ficha.etiqueta} />
                    {envio.intentos > 1 ? (
                      <>
                        <br />
                        <small>{formatearEntero(envio.intentos)} intentos</small>
                      </>
                    ) : null}
                  </td>
                  <td style={CELDA_LARGA}>
                    {motivo ? (
                      <>
                        <strong>{motivo.titulo}</strong>
                        {motivo.transitorio ? ' (rechazo temporal)' : ''}
                        <br />
                        {motivo.queHacer}
                        {motivo.tecnico ? (
                          <details>
                            <summary>Texto del servidor de correo</summary>
                            <code>{motivo.tecnico}</code>
                          </details>
                        ) : null}
                      </>
                    ) : (
                      ficha.explicacion
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="section-explanation">
        Del más reciente al más antiguo. Los correos de las personas se muestran en esta pantalla y
        no viajan en el enlace: si necesitas compartir un caso, comparte la ronda o el período, no
        la dirección.
      </p>
    </div>
  );
}

function EstadoChip({ tono, etiqueta }: { tono: 'ok' | 'espera' | 'alerta'; etiqueta: string }) {
  // Se reusan las clases que ya existen en globals.css —ese archivo lo tocan
  // varios carriles y no vale la pena pelearselo por tres colores—: la pastilla
  // verde de «en curso», la ámbar de «pendiente» y el chip rojo de la auditoria.
  if (tono === 'alerta') return <span className="stats-chip alerta">{etiqueta}</span>;
  if (tono === 'ok') return <span className="status-pill active">{etiqueta}</span>;
  return <span className="status-pill pending">{etiqueta}</span>;
}

/* ------------------------------------------------------------------ */
/* Leyenda                                                             */
/* ------------------------------------------------------------------ */

/**
 * Que significa cada estado.
 *
 * Va cerrada y al final: no es lo que se viene a mirar. Pero tiene que estar,
 * porque la diferencia entre «Salió» y «Llegó» es justamente la que hace que
 * soporte le prometa al cliente algo que no puede sostener.
 */
function LeyendaEstados() {
  return (
    <details className="stats-detalle">
      <summary>Qué significa cada estado</summary>
      <div className="stats-detalle-cuerpo">
        <p className="section-explanation">
          «Salió» y «Llegó» no son lo mismo. Que nuestro servidor le entregue el correo al del
          destinatario solo dice que ese servidor se hizo cargo de intentarlo; que haya entrado al
          buzón lo confirma después el proveedor de correo.
        </p>
        <div className="stats-tabla-envoltura">
          <table className="stats-tabla">
            <caption className="stats-invisible">
              Estados de un envío de correo y qué significa cada uno
            </caption>
            <thead>
              <tr>
                <th scope="col">Estado</th>
                <th scope="col">¿Llegó?</th>
                <th scope="col">Qué significa</th>
              </tr>
            </thead>
            <tbody>
              {ESTADOS_ENVIO.map((clave) => {
                const ficha = CATALOGO_ESTADOS[clave];
                return (
                  <tr key={clave}>
                    <th scope="row">
                      <EstadoChip tono={ficha.tono} etiqueta={ficha.etiqueta} />
                    </th>
                    <td>{ficha.llego === null ? 'No se sabe' : ficha.llego ? 'Sí' : 'No'}</td>
                    <td style={CELDA_LARGA}>{ficha.explicacion}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </details>
  );
}

/* ------------------------------------------------------------------ */
/* Estados de la pantalla                                              */
/* ------------------------------------------------------------------ */

function Estado({ resultado }: { resultado: Resultado<unknown> }) {
  if (resultado.estado === 'ok') return null;

  if (resultado.estado === 'sin-permiso') {
    return (
      <p className="stats-estado aviso" role="status">
        <strong>No tienes acceso al registro de correos de esta empresa.</strong> Lo revisan los
        administradores. Si necesitas verlo, pídele a uno que te dé ese acceso.
      </p>
    );
  }

  if (resultado.estado === 'sin-sesion') {
    return (
      <p className="stats-estado aviso" role="status">
        Tu sesión expiró. Vuelve a ingresar para ver el registro de correos.
      </p>
    );
  }

  return (
    <p className="stats-estado error" role="alert">
      No pudimos consultar el registro de correos. Vuelve a intentarlo en un momento; si sigue
      igual, avisa al equipo técnico.
    </p>
  );
}

/**
 * Sin resultados.
 *
 * NO dice «no se envió nada»: con un filtro puesto, lo unico cierto es que no
 * hay nada que calce con ese filtro. Confundir las dos cosas en una pantalla de
 * soporte termina en «le confirmo que no salió» cuando salió con otra plantilla.
 */
function Vacio({ filtro }: { filtro: FiltroEnvios }) {
  const conFiltro =
    filtro.recinto !== '' ||
    filtro.estado !== '' ||
    filtro.plantilla !== '' ||
    filtro.desde !== '' ||
    filtro.hasta !== '';

  if (filtro.ronda) {
    return (
      <div className="dashboard-empty stats-vacio">
        <strong>Esta ronda no tiene correos registrados</strong>
        <span>
          Puede ser que todavía no se haya despachado su informe, o que se haya despachado antes de
          que existiera este registro.
        </span>
      </div>
    );
  }

  return (
    <div className="dashboard-empty stats-vacio">
      <strong>{conFiltro ? 'Ningún correo calza con este filtro' : 'No hay correos registrados'}</strong>
      <span>
        {conFiltro
          ? 'Prueba con un período más amplio o sin el tipo de correo: que no calce con el filtro no significa que no se haya enviado.'
          : 'Cuando el sistema envíe un correo —un informe, una invitación, una recuperación de clave— aparecerá acá con su estado.'}
      </span>
    </div>
  );
}
