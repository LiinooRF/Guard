/**
 * Estadisticas e informes del SUPERVISOR (#99) — tipos y calculo puro.
 *
 * Aca no hay React ni fetch a proposito: es lo unico de este issue que se puede
 * probar con Jest sin levantar navegador ni base de datos. Los componentes solo
 * dibujan lo que esto devuelve.
 *
 * Lo que el issue #99 pide y este archivo resuelve:
 *
 * · **Que puntos se omiten SIEMPRE.** `/stats/charts/missed-checkpoints` ordena
 *   por cantidad de omisiones, y por eso un punto saltado 40 veces de 400 (10%)
 *   aparece ARRIBA de uno saltado 12 de 12 (100%). Para "se omite siempre" el
 *   orden util es el otro. Eso lo hace `clasificarOmisiones()`.
 *
 *   OJO con el alcance de ese reorden, porque es la limitacion mas seria de la
 *   tarjeta: el SQL del endpoint termina en
 *   `ORDER BY omitidos DESC, pct_omision DESC, c.name LIMIT $6::int`
 *   (stats-charts.service.ts). O sea, el servidor **recorta primero por cantidad
 *   absoluta** y solo despues llega el listado aca. Reordenar por porcentaje
 *   arregla el orden de lo que llego, NO recupera lo que el corte dejo afuera:
 *   con mas puntos omitidos que el tope, el 12-de-12 puede no viajar nunca.
 *   Por eso existen `TOPE_PUNTOS_OMITIDOS` y `omisionesTruncadas()`, y por eso
 *   la tarjeta lo dice en pantalla en vez de presentar la lista como completa.
 *   El arreglo de fondo es un `orderBy` en el endpoint, pedido en INTEGRACION.md.
 * · **Cumplimiento por ruta.** Ya NO se calcula aca. Lo agrega el servidor en
 *   `GET /api/stats/charts/compliance-by-route`, que agrupa por `routes.id`,
 *   descarta las rondas voluntarias y las abiertas, y corta el periodo con
 *   `sites.timezone`. Las tres cosas eran imposibles desde el navegador, porque
 *   el listado de rondas del recinto no expone `route_id` ni `is_voluntary` y
 *   viene ordenado por fecha programada, futuras incluidas. De la version
 *   anterior solo quedan aca el tope de filas y la comparacion de duraciones.
 *
 * Lo que NO se hace aca, y es deliberado:
 *
 * · No se calcula ningun umbral. El "% desde el cual un punto es cronico" es una
 *   regla de negocio: sale de rules.ts por la cascada y llega ya resuelto en
 *   `GET /api/rules/effective`. Si todavia no esta configurada, la tarjeta
 *   ordena igual pero NO marca nada como cronico — un default escrito aca seria
 *   exactamente lo que la regla 3 del producto prohibe.
 * · No se convierte ninguna zona horaria. El corte del periodo lo hace el SQL
 *   contra `sites.timezone`; el navegador manda dias `YYYY-MM-DD` y nada mas.
 */

import type { PuntoOmitido, ClaveGrafica } from './stats-charts-data';

/* ------------------------------------------------------------------ */
/* Estado de una consulta                                              */
/* ------------------------------------------------------------------ */

/**
 * Es un union y no un `T | null` para que "vacio", "no es tu recinto" y "se
 * cayo" no puedan confundirse en el render. Para el SUPERVISOR la diferencia
 * importa mas que para nadie: un 403 de `/supervisor/...` es el alcance por
 * recinto funcionando, no una falla.
 */
export type ResultadoSupervisor<T> =
  | { estado: 'ok'; datos: T }
  | { estado: 'sin-sesion' }
  | { estado: 'sin-permiso' }
  | { estado: 'rango-rechazado'; mensaje: string }
  | { estado: 'fuera-de-tope'; clave: ClaveGrafica }
  | { estado: 'error' };

/* ------------------------------------------------------------------ */
/* Recintos asignados                                                  */
/* ------------------------------------------------------------------ */

/**
 * Una fila de `GET /api/supervisor/sites`, tal como la arma
 * `supervisor.service.ts -> listAssignedSites`: los recintos ACTIVOS que el
 * usuario tiene en `supervisor_sites`, ordenados por sucursal y nombre.
 *
 * Solo se declara lo que esta pantalla usa. La respuesta trae ademas
 * `address`, `latitude`, `longitude` y `timezone`, que son del mapa.
 */
export interface RecintoAsignado {
  id: string;
  name: string;
  branchName: string;
}

/* ------------------------------------------------------------------ */
/* Rondas de un recinto                                                */
/* ------------------------------------------------------------------ */

/**
 * Respuesta de `GET /api/supervisor/sites/:siteId/patrols`, tal como la arma
 * `supervisor.service.ts -> listPatrols`. El servidor responde 403 si el
 * recinto no esta en `supervisor_sites` del usuario: el alcance no se decide
 * aca.
 */
export interface RondaSupervisor {
  id: string;
  routeName: string;
  guardName: string;
  status: string;
  /** Instante ISO. No se convierte a ninguna zona en este archivo. */
  scheduledStartAt: string;
  scheduledEndAt: string;
  compliancePct: number | null;
}

/**
 * Tope de filas que devuelve ese endpoint. Es el `LIMIT 100` de su SQL, no una
 * decision de esta pantalla: se anota aca para poder AVISAR cuando el listado
 * viene cortado, en vez de mostrar un promedio calculado sobre un pedazo y
 * presentarlo como si fuera el periodo completo.
 */
export const TOPE_RONDAS_LISTADO = 100;

/** Como se lee cada estado en pantalla. Los valores son los de la base. */
export const ETIQUETA_ESTADO: Record<string, string> = {
  pendiente: 'Pendiente',
  en_curso: 'En curso',
  completada: 'Completada',
  incompleta: 'Incompleta',
  vencida: 'Vencida',
};

export function etiquetaEstado(estado: string): string {
  return ETIQUETA_ESTADO[estado] ?? estado;
}

/** `true` si el listado vino tocando el tope y por lo tanto puede faltar historia. */
export function listadoTruncado(rondas: readonly RondaSupervisor[]): boolean {
  return rondas.length >= TOPE_RONDAS_LISTADO;
}

/* ------------------------------------------------------------------ */
/* Cumplimiento por ruta                                               */
/* ------------------------------------------------------------------ */

/**
 * Cuantas rutas se le piden a `GET /api/stats/charts/compliance-by-route`. Es el
 * maximo que acepta su DTO (`TopQueryDto`, `@Max(50)`), no una decision de
 * negocio.
 *
 * Se pide el maximo aunque la tarjeta mire un solo recinto: el servidor ordena
 * de PEOR a mejor, asi que un corte por abajo deja fuera las rutas sanas y no
 * las que hay que arreglar — pero si el recinto tuviera mas de 50 rutas, la
 * ultima que se ve seria arbitraria y hay que decirlo.
 */
export const TOPE_RUTAS = 50;

/** `true` si la respuesta vino tocando el tope y por lo tanto puede faltar alguna ruta. */
export function rutasTruncadas(rutas: readonly unknown[]): boolean {
  return rutas.length >= TOPE_RUTAS;
}

/**
 * Minutos que la ruta se pasa —o le sobran— respecto de lo que dice durar.
 *
 * No es un juicio sobre el guardia: es la pregunta que pide el issue, la de las
 * rutas poco realistas. Si el promedio real supera al estimado, la ruta no cabe
 * en el tiempo que tiene asignado, y por eso queda a medias con guardias
 * distintos; sacarle puntos o alargar la ventana arregla mas que hablar con la
 * persona. Devuelve `null` cuando no hay con que comparar: ninguna ronda del
 * periodo llego a iniciarse, o la ruta no declara duracion.
 */
export function excesoDeDuracion(ruta: {
  estimatedDurationMin: number;
  avgDurationMin: number | null;
}): number | null {
  if (ruta.avgDurationMin === null) return null;
  if (!Number.isFinite(ruta.estimatedDurationMin) || ruta.estimatedDurationMin <= 0) return null;
  return Math.round((ruta.avgDurationMin - ruta.estimatedDurationMin) * 10) / 10;
}

/* ------------------------------------------------------------------ */
/* Puntos que se omiten siempre                                        */
/* ------------------------------------------------------------------ */

/**
 * Los dos parametros con que se decide si un punto "se omite siempre".
 *
 * Viven en `rules.ts` y llegan resueltos por la cascada en
 * `GET /api/rules/effective`. Se leen con nombre explicito y comentario para no
 * repetir el error de `gpsSharingMandatory`, donde se confundio "obligatorio vs
 * opcional" con "encendido vs apagado":
 *
 * · `umbralPct` NO es el umbral de cumplimiento de la ronda
 *   (`complianceThreshold`). Ese mide cuanto se cumplio; este mide cuantas
 *   veces se salto UN punto. Son numeros distintos y sentidos contrarios.
 * · `minimoRondas` NO filtra rondas ni cambia el porcentaje: solo decide si el
 *   porcentaje tiene muestra suficiente para llamarlo cronico. Un punto
 *   esperado una vez y omitido esa vez es 100%, y no dice nada.
 */
export interface ReglasOmision {
  /** `chronicMissThresholdPct`: desde este % de omision el punto es cronico. */
  umbralPct: number;
  /** `chronicMissMinPatrols`: rondas esperadas minimas para poder clasificarlo. */
  minimoRondas: number;
}

/**
 * Lee las dos reglas del cuerpo de `GET /api/rules/effective`.
 *
 * Devuelve `null` —y no un default— cuando falta cualquiera de las dos o viene
 * fuera de rango. Con `null` la tarjeta sigue sirviendo (ordena por porcentaje
 * de omision) pero no etiqueta nada, y dice por que. Mientras el integrador no
 * aplique las reglas de INTEGRACION.md, esta funcion devuelve `null`: por eso
 * lee de una bolsa y no de `PatrolRules`, para que el panel compile y funcione
 * antes y despues del cambio.
 */
export function leerReglasOmision(reglas: unknown): ReglasOmision | null {
  if (typeof reglas !== 'object' || reglas === null) return null;
  const bolsa = reglas as Record<string, unknown>;
  const umbral = bolsa['chronicMissThresholdPct'];
  const minimo = bolsa['chronicMissMinPatrols'];
  if (typeof umbral !== 'number' || !Number.isInteger(umbral)) return null;
  if (typeof minimo !== 'number' || !Number.isInteger(minimo)) return null;
  /*
   * Lo unico que se valida aca es lo que NO puede cambiar aunque cambie
   * rules.ts: un porcentaje de omision vive entre 1 y 100 por definicion, y una
   * cantidad de rondas es un entero positivo.
   *
   * El tope de 500 rondas que propone INTEGRACION.md para
   * `chronicMissMinPatrols` NO se repite aca a proposito. Copiarlo dejaria dos
   * fuentes del mismo numero, y el dia que el zod del servidor lo suba, el panel
   * descartaria EN SILENCIO un valor legitimo y volveria a "Sin umbral
   * configurado" sin que el usuario vea ningun error. Quien manda es el zod del
   * servidor; aca solo se descarta lo que no tiene forma de regla.
   */
  if (umbral < 1 || umbral > 100) return null;
  if (minimo < 1) return null;
  return { umbralPct: umbral, minimoRondas: minimo };
}

/**
 * · `cronico`     — se omite tantas veces que la ruta no se esta pudiendo hacer.
 * · `ocasional`   — se salta a veces, con muestra suficiente para afirmarlo.
 * · `muestra-corta` — se omitio, pero en muy pocas rondas para concluir algo.
 * · `sin-clasificar` — faltan las reglas; solo se muestra el porcentaje.
 */
export type NivelOmision = 'cronico' | 'ocasional' | 'muestra-corta' | 'sin-clasificar';

export interface PuntoOmision extends PuntoOmitido {
  nivel: NivelOmision;
  /** `true` para puntos `acceso_critico`: ahi la omision pesa mas. */
  critico: boolean;
}

/**
 * Cuantos puntos se le piden a `missed-checkpoints`. Es el maximo que acepta su
 * DTO (`TopQueryDto`, `@Max(50)`), no una decision de negocio.
 *
 * Se pide el maximo porque el servidor elige ese top **por cantidad absoluta de
 * omisiones** (`ORDER BY omitidos DESC ... LIMIT`), que es justo el criterio
 * contrario al que esta tarjeta necesita. Cuanto mas ancha la red, menos
 * probable que el punto de baja frecuencia que se salta siempre quede fuera.
 * Reducir el riesgo no es eliminarlo: ver `omisionesTruncadas()`.
 */
export const TOPE_PUNTOS_OMITIDOS = 50;

/**
 * `true` si la respuesta vino tocando el tope, es decir: el corte del servidor
 * SI se aplico y puede haber dejado fuera un punto con pocas omisiones
 * absolutas pero 100% de omision.
 *
 * Si vinieron menos filas que el tope, el listado es exhaustivo: el SQL trae
 * todos los puntos con al menos una omision en el periodo
 * (`HAVING count(*) FILTER (WHERE NOT e.escaneado) > 0`), asi que ahi el orden
 * por porcentaje si responde la pregunta del issue sin salvedades.
 */
export function omisionesTruncadas(puntos: readonly unknown[]): boolean {
  return puntos.length >= TOPE_PUNTOS_OMITIDOS;
}

const ORDEN_NIVEL: Record<NivelOmision, number> = {
  cronico: 0,
  'sin-clasificar': 1,
  ocasional: 1,
  'muestra-corta': 2,
};

function nivelDe(punto: PuntoOmitido, reglas: ReglasOmision | null): NivelOmision {
  if (reglas === null) return 'sin-clasificar';
  if (punto.expected < reglas.minimoRondas) return 'muestra-corta';
  return punto.missedPct >= reglas.umbralPct ? 'cronico' : 'ocasional';
}

/**
 * Clasifica y REORDENA los puntos omitidos para responder "cual se salta
 * siempre", que es el criterio de aceptacion del issue.
 *
 * El orden es: primero los cronicos, despues los ocasionales, y al final los de
 * muestra corta —que no se esconden, pero no encabezan una conversacion con el
 * guardia—. Dentro de cada grupo manda el porcentaje de omision y no la
 * cantidad: 12 de 12 pesa mas que 40 de 400.
 *
 * ATENCION: esto reordena **lo que el servidor ya entrego**, y el servidor
 * recorto por cantidad absoluta (ver `TOPE_PUNTOS_OMITIDOS`). Si la respuesta
 * vino llena, el 12-de-12 pudo quedar fuera del corte y esta funcion no lo puede
 * inventar. Quien dibuja tiene que avisarlo: `omisionesTruncadas()`.
 */
export function clasificarOmisiones(
  puntos: readonly PuntoOmitido[],
  reglas: ReglasOmision | null,
): PuntoOmision[] {
  return puntos
    .map((punto) => ({
      ...punto,
      nivel: nivelDe(punto, reglas),
      critico: punto.kind === 'acceso_critico',
    }))
    .sort(
      (a, b) =>
        ORDEN_NIVEL[a.nivel] - ORDEN_NIVEL[b.nivel] ||
        b.missedPct - a.missedPct ||
        b.missed - a.missed ||
        a.checkpointName.localeCompare(b.checkpointName, 'es'),
    );
}

export interface ResumenOmisiones {
  puntos: number;
  cronicos: number;
  criticosCronicos: number;
  muestraCorta: number;
  /** Suma de veces que se dejo un punto sin marcar en el periodo. */
  omisiones: number;
  /** Recintos distintos con al menos un punto omitido. */
  recintos: number;
}

export function resumirOmisiones(puntos: readonly PuntoOmision[]): ResumenOmisiones {
  const cronicos = puntos.filter((punto) => punto.nivel === 'cronico');
  return {
    puntos: puntos.length,
    cronicos: cronicos.length,
    criticosCronicos: cronicos.filter((punto) => punto.critico).length,
    muestraCorta: puntos.filter((punto) => punto.nivel === 'muestra-corta').length,
    omisiones: puntos.reduce((total, punto) => total + punto.missed, 0),
    recintos: new Set(puntos.map((punto) => punto.siteName)).size,
  };
}

/* ------------------------------------------------------------------ */
/* Alcance: que recinto se esta mirando                                */
/* ------------------------------------------------------------------ */

const FORMATO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `true` si el texto tiene forma de UUID.
 *
 * Se comprueba ANTES de pedir: el endpoint valida el parametro con `@IsUUID()`
 * y responderia 400. Un 400 por una URL editada a mano no es informacion util
 * para un jefe de operaciones.
 */
export function esUuid(valor: string): boolean {
  return FORMATO_UUID.test(valor);
}

/**
 * Un UUID escrito en mayusculas es el MISMO id: `@IsUUID()` lo acepta y Postgres
 * lo compara igual, pero la API los devuelve siempre en minuscula. Sin
 * normalizar, `===` fallaba y el panel daba por no confirmado un recinto que si
 * estaba en la respuesta: pintaba "Recinto asignado" en vez del nombre y el
 * aviso FALSO de "no aparece entre los que tuvieron rondas".
 */
export function normalizarUuid(valor: string): string {
  return valor.toLowerCase();
}

export interface RecintoElegido {
  id: string;
  /**
   * Nombre SOLO si el recinto vino en la respuesta del servidor. Nunca sale de
   * la URL: pintar en pantalla un nombre que puso quien escribio el enlace es
   * como se filtra la existencia de un recinto ajeno.
   */
  nombre: string | null;
  sucursal: string | null;
  /** `true` si el id aparece entre los recintos que el servidor devolvio. */
  confirmado: boolean;
}

/**
 * Lo minimo que esta funcion necesita saber de un recinto.
 *
 * Se escribe estructural y no como `RecintoCumplimiento` porque el catalogo de
 * recintos del panel salio primero de `/stats/charts/compliance-by-site` —que
 * solo devuelve los que TUVIERON rondas en el periodo— y hoy sale de
 * `GET /supervisor/sites`, que devuelve los asignados. Las dos formas entran
 * aca sin que la funcion tenga que saber de cual viene.
 */
export interface RecintoDelCatalogo {
  siteId: string;
  siteName: string;
  branchName: string;
}

/**
 * Decide que recinto miran las tarjetas de ruta e informes.
 *
 * Si el filtro no trae recinto y el supervisor tiene uno solo asignado, se abre
 * ese: obligarlo a elegir entre una opcion es una pantalla vacia por nada.
 *
 * Si trae un id que no esta en la lista, igual se devuelve —sin nombre y sin
 * confirmar—: puede ser un recinto asignado que simplemente no tuvo rondas en
 * el periodo, y quien decide si se puede ver es el servidor, no esta funcion.
 */
export function elegirRecinto(
  recintos: readonly RecintoDelCatalogo[],
  pedido: string,
): RecintoElegido | null {
  if (!pedido || !esUuid(pedido)) {
    const unico = recintos.length === 1 ? recintos[0] : undefined;
    if (!unico) return null;
    return {
      id: unico.siteId,
      nombre: unico.siteName,
      sucursal: unico.branchName,
      confirmado: true,
    };
  }

  const buscado = normalizarUuid(pedido);
  const encontrado = recintos.find((recinto) => normalizarUuid(recinto.siteId) === buscado);
  if (encontrado) {
    return {
      id: encontrado.siteId,
      nombre: encontrado.siteName,
      sucursal: encontrado.branchName,
      confirmado: true,
    };
  }
  return { id: buscado, nombre: null, sucursal: null, confirmado: false };
}

/**
 * Enlace a esta misma pagina con el recinto elegido, conservando el periodo.
 *
 * Se parte de los parametros que YA venian en la URL (`actuales`) y solo se
 * sobreescribe lo que este enlace cambia. Armar la URL desde cero borraba en
 * silencio `agrupacion`, que `stats-charts.tsx` lee en esta misma pantalla:
 * elegir un recinto en la lista de informes reseteaba la granularidad que el
 * usuario habia fijado en la grafica de evolucion de arriba.
 */
export function enlaceRecinto(
  base: { desde: string; hasta: string; sucursal: string },
  siteId: string,
  actuales?: Readonly<Record<string, string>>,
): string {
  const parametros = new URLSearchParams(actuales ?? {});
  parametros.set('desde', base.desde);
  parametros.set('hasta', base.hasta);
  if (base.sucursal) parametros.set('sucursal', base.sucursal);
  else parametros.delete('sucursal');
  parametros.set('recinto', siteId);
  return `?${parametros.toString()}#supervisor-informes`;
}
