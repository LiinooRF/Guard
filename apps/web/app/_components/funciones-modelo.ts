/**
 * Logica de la pantalla "Funciones del sistema" (#102), sin React.
 *
 * En esta pantalla conviven DOS cosas que no son lo mismo y que se rompen
 * distinto si se confunden:
 *
 *   MODULOS  = que compro la empresa. El techo lo pone la licencia (plan +
 *              acuerdo puntual) y el admin solo puede APAGAR dentro de ese
 *              techo, nunca ampliarlo.   GET/PUT /api/features/admin
 *   REGLAS   = como opera la empresa. Cascada plataforma -> empresa -> recinto
 *              -> punto, la resuelve el servidor.   GET/PUT /api/rules/admin
 *
 * Aca vive lo que se puede probar sin navegador. No hay ni un nombre de regla,
 * ni un rango, ni un numero de negocio escrito a mano: todo sale del catalogo
 * que devuelve el servidor. Si manana entra una regla o un modulo nuevo,
 * aparece solo.
 *
 * Lo que NO hace este archivo: reimplementar el editor de la cascada. Ese es
 * `reglas-panel.tsx` (#83) y de ahi se reusan sus funciones puras en vez de
 * copiarlas.
 */
import type { AnyRuleParameter, FeatureFlags, RuleScope } from '@sentrycore/shared';

import {
  mismoValor,
  normalizarValor,
  valorResultante,
  NIVEL_TITULO,
  type ClaveRegla,
  type EstadoReglas,
  type ValoresDeReglas,
} from './reglas-catalogo';

/* ------------------------------------------------------------------ *
 * Modulos vendidos por licencia
 * ------------------------------------------------------------------ */

/** Clave de un modulo. Sale del contrato compartido, no de una lista de aca. */
export type ClaveModulo = keyof FeatureFlags;

/**
 * Ficha de un modulo tal como la devuelve GET /api/features/catalog.
 *
 * El tipo original (`FeatureModule`) vive hoy en apps/api y no en
 * @sentrycore/shared, asi que la web no lo puede importar y declara la forma
 * estructural. Mover esa ficha a @sentrycore/shared borraria esta duplicacion: esta
 * anotado en INTEGRACION.md.
 */
export interface FichaModulo {
  key: ClaveModulo;
  /** Nombre corto para el panel. */
  label: string;
  /** Que hace, en lenguaje del jefe de operaciones. */
  description: string;
  /** Que deja de verse cuando el modulo esta apagado. */
  whenOff: string;
  default: boolean;
}

/**
 * Respuesta de GET /api/features/admin y de su PUT.
 *
 * Trae las fichas del catalogo adentro (`modules`, `editable`) y las etiquetas
 * de cada nivel (`sourceLabels`), asi que la pantalla NO necesita pedir tambien
 * GET /api/features/catalog.
 */
export interface VistaModulos {
  /** Plan contratado. Puede venir en null si el JOIN no encontro plan. */
  plan: { key: string; name: string } | null;
  /** Modulo efectivo = incluido en la licencia Y encendido por el admin. */
  enabled: Partial<Record<ClaveModulo, boolean>>;
  sources: Partial<Record<ClaveModulo, string>>;
  sourceLabels: Record<string, string>;
  /** El techo: lo que la licencia incluye. El admin no lo puede subir. */
  entitlements: Partial<Record<ClaveModulo, boolean>>;
  entitlementSources: Partial<Record<ClaveModulo, string>>;
  /** Lo crudo que quedo guardado como preferencia del admin. */
  stored: Record<string, unknown>;
  /** Solo los modulos que el admin puede tocar (los que su licencia incluye). */
  editable: readonly FichaModulo[];
  /** El catalogo completo, para poder nombrar tambien lo que no es editable. */
  modules: readonly FichaModulo[];
}

export interface EstadoModulo {
  clave: ClaveModulo;
  ficha: FichaModulo;
  /** Lo que muestra el interruptor: encendido para esta empresa. */
  encendido: boolean;
  /** El admin dejo algo escrito; si no, rige el valor de fabrica del producto. */
  escrito: boolean;
  /** Quien decidio el valor efectivo, ya en palabras (sourceLabels del servidor). */
  origen: string;
}

export type EstadoModulos = Partial<Record<ClaveModulo, EstadoModulo>>;

/**
 * Estado inicial de los interruptores de modulos.
 *
 * Se recorre `editable` y no `modules` a proposito: un modulo que la licencia
 * no incluye DESAPARECE, no queda visible y bloqueado. Es la misma decision que
 * toma el servidor cuando responde 404 en vez de 403 (ver
 * FeatureFlagsService.assertEnabled): un 403 confirmaria que el modulo existe y
 * que a la empresa le falta pagarlo.
 */
export function estadoInicialModulos(vista: VistaModulos): EstadoModulos {
  const estado: EstadoModulos = {};

  for (const ficha of vista.editable) {
    const nivel = vista.sources[ficha.key];
    estado[ficha.key] = {
      clave: ficha.key,
      ficha,
      // Dentro de la licencia, lo efectivo ES la preferencia del admin.
      encendido: vista.enabled[ficha.key] ?? ficha.default,
      escrito: typeof vista.stored[ficha.key] === 'boolean',
      origen: (nivel ? vista.sourceLabels[nivel] : undefined) ?? nivel ?? '',
    };
  }

  return estado;
}

/**
 * Cuerpo del PUT de modulos: lo que el admin YA tenia escrito mas lo que movio
 * en esta sesion. Nunca lo editable completo.
 *
 * El PUT reemplaza el set completo de preferencias, asi que hay que mandar todo
 * lo escrito: omitir una preferencia vigente la devolveria a su valor de fabrica
 * sin que nadie lo pidiera. Pero mandar TAMBIEN lo que nunca se toco convierte
 * el valor de fabrica en una decision explicita del admin que el admin no tomo:
 * la insignia "Valor de fabrica" desaparece para siempre y un cambio futuro del
 * default del producto ya no llega a esa empresa. Omitir eso es equivalente en
 * efecto (`resolveFeatureFlags` cae al default cuando la clave no esta) y
 * ademas deja la empresa enganchada al default.
 *
 * Se manda solo lo editable porque prender algo fuera de la licencia responde
 * 403 nombrando el modulo.
 */
export function cuerpoDelPutModulos(
  base: EstadoModulos,
  estado: EstadoModulos,
): Partial<FeatureFlags> {
  const cuerpo: Record<string, boolean> = {};
  for (const campo of Object.values(estado)) {
    if (!campo) continue;
    const previo = base[campo.clave];
    const movido = previo !== undefined && previo.encendido !== campo.encendido;
    if (!campo.escrito && !movido) continue;
    cuerpo[campo.clave] = campo.encendido;
  }
  return cuerpo as Partial<FeatureFlags>;
}

export interface CambioModulo {
  clave: ClaveModulo;
  etiqueta: string;
  antes: boolean;
  despues: boolean;
}

export function resumirCambiosModulos(
  base: EstadoModulos,
  actual: EstadoModulos,
): CambioModulo[] {
  const cambios: CambioModulo[] = [];
  for (const campo of Object.values(actual)) {
    if (!campo) continue;
    const previo = base[campo.clave];
    if (!previo || previo.encendido === campo.encendido) continue;
    cambios.push({
      clave: campo.clave,
      etiqueta: campo.ficha.label,
      antes: previo.encendido,
      despues: campo.encendido,
    });
  }
  return cambios;
}

/**
 * Preferencias guardadas que hoy NO se aplican porque la licencia ya no las
 * incluye (tipicamente: le bajaron el plan a la empresa despues de que el admin
 * las dejo escritas).
 *
 * Importa avisarlo porque el proximo guardado de esta pantalla las borra: el
 * PUT reemplaza el set completo y solo puede mandar lo que la licencia incluye.
 * Que desaparezcan en silencio seria peor que decirlo.
 */
export function preferenciasQueSeLimpian(vista: VistaModulos): {
  conocidas: readonly FichaModulo[];
  desconocidas: number;
} {
  const editables = new Set<string>(vista.editable.map((ficha) => ficha.key));
  const porClave = new Map<string, FichaModulo>(
    vista.modules.map((ficha) => [ficha.key, ficha]),
  );

  const conocidas: FichaModulo[] = [];
  let desconocidas = 0;

  for (const clave of Object.keys(vista.stored)) {
    if (editables.has(clave)) continue;
    const ficha = porClave.get(clave);
    if (ficha) conocidas.push(ficha);
    // Un modulo que ya no existe en el catalogo se cuenta pero no se nombra:
    // su clave interna no le dice nada al jefe de operaciones.
    else desconocidas += 1;
  }

  return { conocidas, desconocidas };
}

/* ------------------------------------------------------------------ *
 * Interruptores de reglas (nivel empresa)
 * ------------------------------------------------------------------ */

/**
 * Los parametros de si/no del nivel: el tablero de funciones de la empresa.
 *
 * El criterio es `type === 'boolean'` del catalogo, NO una lista de claves
 * escrita aca. Una regla nueva de si/no aparece sola en el tablero.
 */
export function interruptoresDelNivel(
  editable: readonly AnyRuleParameter[],
): readonly AnyRuleParameter[] {
  return editable.filter((parametro) => parametro.type === 'boolean');
}

/**
 * Los que llevan un valor (umbral, retencion, destinatarios, radios). Se
 * muestran como resumen de solo lectura: afinar numeros es el trabajo del panel
 * de reglas, que ademas cubre recinto y punto de control.
 */
export function ajustesConValor(
  editable: readonly AnyRuleParameter[],
): readonly AnyRuleParameter[] {
  return editable.filter((parametro) => parametro.type !== 'boolean');
}

/**
 * Consecuencia de dejar una regla de si/no en una posicion, SOLO si el catalogo
 * la trae escrita.
 *
 * Devuelve null mientras la ficha no tenga `whenOn`/`whenOff` (hoy no los
 * tiene; el texto exacto propuesto esta en INTEGRACION.md). NO se inventa la
 * frase a partir del valor: leer "exigir permiso de ubicacion = No" como si
 * fuera "no se registra la ubicacion" es el error que ya le dijo a un
 * trabajador que no lo ubicaban mientras el servidor si lo ubicaba. Obligatorio
 * contra OPCIONAL no es lo mismo que encendido contra apagado.
 */
export function consecuenciaDeclarada(
  parametro: AnyRuleParameter,
  valor: boolean,
): string | null {
  const ficha = parametro as AnyRuleParameter & { whenOn?: unknown; whenOff?: unknown };
  const texto = valor ? ficha.whenOn : ficha.whenOff;
  return typeof texto === 'string' && texto.trim().length > 0 ? texto.trim() : null;
}

/**
 * Parametros que este tablero no muestra y que tienen guardado un valor que el
 * servidor descarto por invalido.
 *
 * Hay que avisarlo: el PUT manda el set completo del nivel, asi que ese valor
 * malo viaja de vuelta y puede hacer que el guardado sea rechazado por algo que
 * el admin no ve en esta pantalla. Se corrige en el panel de reglas.
 */
export function descartadosFueraDelTablero(
  estado: EstadoReglas,
  ocultos: readonly AnyRuleParameter[],
): readonly AnyRuleParameter[] {
  return ocultos.filter((parametro) => estado[parametro.key]?.descartado === true);
}

/**
 * Dos fotos de los overrides de un mismo nivel guardan exactamente el mismo set.
 *
 * Es la comprobacion que evita el pisoton entre paneles. Esta pantalla y el
 * panel de reglas (#83) editan el MISMO recurso (`PUT /rules/admin`) con
 * semantica de reemplazo total, y cada uno tiene su propia foto tomada al
 * cargar la pagina. Si el admin guarda en uno y despues en el otro, el segundo
 * PUT devuelve al valor viejo todo lo que el primero cambio, en silencio. Antes
 * de mandar el set completo hay que confirmar que la foto local sigue siendo la
 * del servidor.
 *
 * `undefined` no es un valor guardado: una clave presente con `undefined` y una
 * clave ausente son el mismo "este nivel no opina" (mismo criterio que
 * `construirEstado`).
 */
export function mismosOverrides(a: ValoresDeReglas, b: ValoresDeReglas): boolean {
  const izquierda = a as Record<string, unknown>;
  const derecha = b as Record<string, unknown>;
  const claves = new Set<string>([...Object.keys(izquierda), ...Object.keys(derecha)]);

  for (const clave of claves) {
    const enA = izquierda[clave];
    const enB = derecha[clave];
    if (enA === undefined && enB === undefined) continue;
    if (!mismoValor(enA, enB)) return false;
  }

  return true;
}

/**
 * El parametro admite excepcion en algun nivel MAS ESPECIFICO que `nivel`.
 *
 * Sirve para no afirmar de mas: lo que esta pantalla guarda y comprueba es el
 * nivel empresa, y un recinto o un punto con excepcion recibe otro valor. El
 * orden de la cascada sale del catalogo (`scopes` de la respuesta), no de una
 * lista escrita aca.
 */
export function admiteExcepcionMasEspecifica(
  parametro: AnyRuleParameter,
  nivel: RuleScope,
  ordenNiveles: readonly RuleScope[],
): boolean {
  const posicion = ordenNiveles.indexOf(nivel);
  if (posicion < 0) return false;
  const masEspecificos = new Set<RuleScope>(ordenNiveles.slice(posicion + 1));
  return parametro.scopes.some((scope) => masEspecificos.has(scope));
}

/* ------------------------------------------------------------------ *
 * Comprobacion contra lo que la app lee de verdad
 * ------------------------------------------------------------------ */

export interface ComprobacionTerreno {
  clave: ClaveRegla;
  etiqueta: string;
  /** Valor efectivo que devuelve el servidor para el contexto de la empresa. */
  efectivo: unknown;
  /** true = lo que rige en terreno no coincide con lo que esta guardado aca. */
  discrepa: boolean;
}

/**
 * Compara lo guardado en el nivel empresa contra lo que responde
 * GET /api/rules/effective, que es exactamente lo que lee la app del guardia.
 *
 * Es la comprobacion del criterio "aplica sin actualizar la app": el admin
 * mueve el interruptor, guarda, y esto vuelve a preguntarle al servidor en vez
 * de creerle a la pantalla. Una interfaz optimista diria "listo" aunque el
 * cambio no hubiera llegado a ninguna parte.
 *
 * `estado` tiene que ser el estado GUARDADO (no el del formulario a medio
 * editar): si no, cualquier edicion sin guardar se veria como una discrepancia.
 */
export function comprobarEnTerreno(
  parametros: readonly AnyRuleParameter[],
  estado: EstadoReglas,
  efectivas: ValoresDeReglas | null,
): ComprobacionTerreno[] {
  if (!efectivas) return [];

  const filas: ComprobacionTerreno[] = [];
  for (const parametro of parametros) {
    const campo = estado[parametro.key];
    if (!campo) continue;
    if (!Object.prototype.hasOwnProperty.call(efectivas, parametro.key)) continue;

    const efectivo = normalizarValor(parametro, efectivas[parametro.key]);
    const esperado = normalizarValor(parametro, valorResultante(campo));
    filas.push({
      clave: parametro.key,
      etiqueta: parametro.label,
      efectivo,
      discrepa: !mismoValor(efectivo, esperado),
    });
  }
  return filas;
}

/* ------------------------------------------------------------------ *
 * Historial de auditoria de la configuracion
 * ------------------------------------------------------------------ */

/** Una fila de GET /api/admin/audit. */
export interface MovimientoAuditoria {
  id: string;
  actorId: string | null;
  /** Se muestra la etiqueta y NUNCA el id: el id puede apuntar a alguien ya eliminado. */
  actorLabel: string;
  action: string;
  entityType: string;
  entityId: string | null;
  summary: string | null;
  createdAt: string;
}

/**
 * Familias de acciones que produce ESTA pantalla. El historial muestra lo que
 * el admin cambio desde aca, no la auditoria completa de la empresa (esa es
 * #104).
 *
 * `modulos` todavia no lo escribe nadie: el PUT de modulos hoy NO deja rastro
 * en auditoria. Esta declarado igual para que aparezca solo el dia que el
 * backend lo registre, sin tocar la web. Ver INTEGRACION.md.
 */
export const FAMILIAS_DE_CONFIGURACION = ['reglas', 'modulos'] as const;

/**
 * Cruza las familias de arriba con las acciones que la empresa REALMENTE tiene
 * registradas (GET /api/admin/audit/actions).
 *
 * Se cruza en vez de pedir a ciegas para no gastar una consulta por cada accion
 * que nunca ocurrio, y para que una familia futura entre sola.
 */
export function accionesDeConfiguracion(presentes: readonly string[]): string[] {
  const familias = new Set<string>(FAMILIAS_DE_CONFIGURACION);
  return presentes.filter((accion) => {
    const familia = accion.split('.')[0];
    return familia !== undefined && familias.has(familia);
  });
}

/**
 * Junta las respuestas de varias consultas (una por accion), quita repetidos y
 * deja lo mas nuevo primero.
 */
export function ordenarMovimientos(
  listas: ReadonlyArray<readonly MovimientoAuditoria[]>,
  tope: number,
): MovimientoAuditoria[] {
  const porId = new Map<string, MovimientoAuditoria>();
  for (const lista of listas) {
    for (const movimiento of lista) {
      if (movimiento?.id) porId.set(movimiento.id, movimiento);
    }
  }

  return [...porId.values()]
    .sort((a, b) => marcaDeTiempo(b.createdAt) - marcaDeTiempo(a.createdAt))
    .slice(0, Math.max(tope, 0));
}

function marcaDeTiempo(valor: string): number {
  const momento = Date.parse(valor);
  // Una fecha ilegible se va al final en vez de tumbar el orden completo.
  return Number.isNaN(momento) ? Number.NEGATIVE_INFINITY : momento;
}

const ETIQUETA_ACCION: Record<string, string> = {
  'reglas.modificadas': 'Reglas de operación',
  'modulos.modificados': 'Módulos del sistema',
};

/** Nombre de la accion para el historial, con salida decente si es desconocida. */
export function etiquetaAccion(accion: string): string {
  const conocida = ETIQUETA_ACCION[accion];
  if (conocida) return conocida;
  const palabras = accion.replace(/[._]+/g, ' ').trim();
  return palabras ? palabras.charAt(0).toLocaleUpperCase('es') + palabras.slice(1) : accion;
}

/**
 * El resumen que guarda el servidor nombra las reglas por su clave interna
 * (`complianceThreshold`) porque los VALORES pueden traer correos y no se
 * escriben en la auditoria. Aca se cambian esas claves por su nombre del
 * catalogo, que es el unico que el jefe de operaciones reconoce.
 *
 * Se reemplaza token a token: si manana cambia el formato del resumen, lo peor
 * que pasa es que no se traduzca nada. No se parsea la frase.
 */
export function resumenEnPalabras(
  resumen: string | null,
  parametros: readonly AnyRuleParameter[],
): string {
  if (!resumen) return 'Sin detalle';

  const diccionario = new Map<string, string>();
  for (const parametro of parametros) diccionario.set(parametro.key, parametro.label);
  for (const [nivel, titulo] of Object.entries(NIVEL_TITULO)) diccionario.set(nivel, titulo);

  return resumen.replace(/[A-Za-z][A-Za-z0-9_]*/g, (token) => diccionario.get(token) ?? token);
}
