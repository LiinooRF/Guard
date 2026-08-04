/**
 * Logica del panel de reglas configurables (#83), sin React.
 *
 * La pantalla NO conoce ni un nombre de campo ni un rango: todo sale de
 * GET /api/rules/catalog y de la vista del nivel (GET /api/rules/admin...).
 * Si manana entra una regla nueva al catalogo, aparece sola en el formulario.
 *
 * Aca vive lo que se puede probar sin navegador: armar el estado del
 * formulario desde la respuesta del servidor, distinguir heredado de propio,
 * construir el cuerpo del PUT y resumir que cambio.
 */
import type {
  AnyRuleParameter,
  PatrolRules,
  RuleGroup,
  RuleScope,
  RuleSource,
} from '@voxia/shared';

/** Clave de una regla. Nunca se escribe literal en la web: siempre viene del catalogo. */
export type ClaveRegla = keyof PatrolRules;

/** Bolsa de valores indexada por clave de regla. */
export type ValoresDeReglas = Partial<Record<ClaveRegla, unknown>>;

/** Respuesta de GET /api/rules/catalog. Es metadato del producto, no de una empresa. */
export interface CatalogoReglas {
  parameters: readonly AnyRuleParameter[];
  /** Niveles de la cascada, del mas general al mas especifico. */
  scopes: readonly RuleScope[];
  valueTypes: readonly string[];
  groups: readonly RuleGroup[];
  groupLabels: Record<string, string>;
  unitLabels: Record<string, string>;
}

/**
 * Respuesta de GET /api/rules/admin y de sus variantes por recinto y por punto.
 * `overrides` viene crudo (incluye lo invalido, a proposito) y `sources` dice
 * de que nivel salio cada valor efectivo.
 */
export interface VistaReglas {
  scope: RuleScope;
  targetId: string | null;
  effective: ValoresDeReglas;
  overrides: ValoresDeReglas;
  sources: Partial<Record<ClaveRegla, RuleSource>>;
  layers: Partial<Record<RuleScope, ValoresDeReglas>>;
  /** Fichas del catalogo que ESTE nivel puede configurar. Lo demas responde 400. */
  editable: readonly AnyRuleParameter[];
}

/** Estado de un parametro dentro del formulario. */
export interface EstadoCampo {
  clave: ClaveRegla;
  /** true = este nivel escribe el valor; false = lo hereda del nivel de arriba. */
  propio: boolean;
  valor: unknown;
  /** Lo que quedaria si se quita el override de este nivel. */
  heredado: unknown;
  /** De donde viene ese valor heredado. */
  origenHeredado: RuleSource;
  /** Hay algo guardado en este nivel que el servidor descarto por invalido. */
  descartado: boolean;
}

export type EstadoReglas = Partial<Record<ClaveRegla, EstadoCampo>>;

/** Como se nombra cada nivel de la cascada frente al usuario. */
export const NIVEL_TITULO: Record<RuleScope, string> = {
  platform: 'Plataforma',
  tenant: 'Toda la empresa',
  site: 'Un recinto',
  checkpoint: 'Un punto de control',
};

const ORIGEN_TEXTO: Record<RuleSource, string> = {
  default: 'el valor de fábrica',
  platform: 'la plataforma',
  tenant: 'la empresa',
  site: 'el recinto',
  checkpoint: 'el punto de control',
};

export function etiquetaOrigen(origen: RuleSource): string {
  return ORIGEN_TEXTO[origen] ?? 'el nivel superior';
}

/** "de la empresa", "del recinto": la contraccion, para no escribir "de el". */
export function deOrigen(origen: RuleSource): string {
  const texto = etiquetaOrigen(origen);
  return texto.startsWith('el ') ? `del ${texto.slice(3)}` : `de ${texto}`;
}

/**
 * Estado inicial del formulario a partir de la vista del servidor.
 *
 * `ordenNiveles` sale del propio catalogo (`scopes`), no de una lista escrita
 * aca: la cascada la define el backend y la web solo la recorre.
 */
export function construirEstado(
  vista: VistaReglas,
  ordenNiveles: readonly RuleScope[],
): EstadoReglas {
  const estado: EstadoReglas = {};

  for (const parametro of vista.editable) {
    const { valor: heredado, origen } = valorHeredado(parametro, vista, ordenNiveles);
    const propio = tieneClave(vista.overrides, parametro.key);
    const guardado = vista.overrides[parametro.key];
    const ganador = vista.sources[parametro.key] ?? 'default';

    estado[parametro.key] = {
      clave: parametro.key,
      propio,
      valor: propio ? guardado : heredado,
      heredado,
      origenHeredado: origen,
      // Escrito en este nivel pero el efectivo salio de otro: el servidor lo
      // descarto por invalido. Se muestra para que el admin lo pueda corregir.
      descartado: propio && ganador !== vista.scope,
    };
  }

  return estado;
}

/**
 * Valor que regiria si este nivel dejara de opinar: el ultimo nivel de la
 * cascada ANTES del actual que tenga la regla escrita, o el default del producto.
 */
function valorHeredado(
  parametro: AnyRuleParameter,
  vista: VistaReglas,
  ordenNiveles: readonly RuleScope[],
): { valor: unknown; origen: RuleSource } {
  let valor: unknown = parametro.default;
  let origen: RuleSource = 'default';

  for (const nivel of ordenNiveles) {
    if (nivel === vista.scope) break;
    const capa = vista.layers[nivel];
    if (!capa || !tieneClave(capa, parametro.key)) continue;
    const candidato = capa[parametro.key];
    // undefined no es un override: es "este nivel no opina".
    if (candidato === undefined) continue;
    valor = candidato;
    origen = nivel;
  }

  return { valor, origen };
}

function tieneClave(bolsa: ValoresDeReglas, clave: ClaveRegla): boolean {
  return Object.prototype.hasOwnProperty.call(bolsa, clave) && bolsa[clave] !== undefined;
}

/**
 * Cuerpo del PUT: SOLO los parametros marcados como propios de este nivel.
 *
 * El PUT reemplaza el set completo del nivel, asi que omitir un campo es
 * exactamente la forma de devolverlo a su valor heredado. Los que ese nivel no
 * admite ni se ofrecen ni se mandan: el servidor responderia 400.
 */
export function cuerpoDelPut(
  estado: EstadoReglas,
  editable: readonly AnyRuleParameter[],
): ValoresDeReglas {
  const cuerpo: ValoresDeReglas = {};
  for (const parametro of editable) {
    const campo = estado[parametro.key];
    if (!campo?.propio) continue;
    cuerpo[parametro.key] = normalizarValor(parametro, campo.valor);
  }
  return cuerpo;
}

/** Lleva lo que escribio el usuario al tipo que declara el catalogo. */
export function normalizarValor(parametro: AnyRuleParameter, valor: unknown): unknown {
  switch (parametro.type) {
    case 'boolean':
      return Boolean(valor);
    case 'integer': {
      const numero = Number(valor);
      return Number.isFinite(numero) ? Math.trunc(numero) : valor;
    }
    case 'email-list':
      return listaDeTexto(valor);
    case 'multi-select': {
      const elegidas = new Set(listaDeTexto(valor));
      // Se respeta el orden del catalogo, no el orden en que el usuario marco.
      return (parametro.options ?? []).filter((opcion) => elegidas.has(opcion));
    }
    default:
      return valor;
  }
}

function listaDeTexto(valor: unknown): string[] {
  if (Array.isArray(valor)) {
    return valor.map((item) => String(item).trim()).filter((item) => item.length > 0);
  }
  if (typeof valor === 'string') {
    return valor
      .split(/[\n,;]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

const CORREO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validacion en el navegador, para avisar antes de mandar. El servidor valida
 * igual: esto es cortesia, no control.
 */
export function validarCampo(parametro: AnyRuleParameter, valor: unknown): string | null {
  if (parametro.type === 'integer') {
    const numero = Number(valor);
    if (valor === '' || valor === null || !Number.isFinite(numero)) {
      return 'Escribe un número.';
    }
    if (!Number.isInteger(numero)) return 'Tiene que ser un número entero.';
    if (parametro.min !== undefined && numero < parametro.min) {
      return `El mínimo permitido es ${parametro.min}.`;
    }
    if (parametro.max !== undefined && numero > parametro.max) {
      return `El máximo permitido es ${parametro.max}.`;
    }
    return null;
  }

  if (parametro.type === 'email-list') {
    const correos = listaDeTexto(valor);
    if (parametro.maxItems !== undefined && correos.length > parametro.maxItems) {
      return `Como máximo ${parametro.maxItems} correos. Hay ${correos.length}.`;
    }
    const malo = correos.find((correo) => !CORREO.test(correo));
    return malo ? `"${malo}" no parece un correo válido.` : null;
  }

  return null;
}

/** Todos los errores del formulario, por clave. Vacio = se puede guardar. */
export function validarFormulario(
  estado: EstadoReglas,
  editable: readonly AnyRuleParameter[],
): Partial<Record<ClaveRegla, string>> {
  const errores: Partial<Record<ClaveRegla, string>> = {};
  for (const parametro of editable) {
    const campo = estado[parametro.key];
    if (!campo?.propio) continue;
    const error = validarCampo(parametro, campo.valor);
    if (error) errores[parametro.key] = error;
  }
  return errores;
}

export type TipoDeCambio = 'definido' | 'ajustado' | 'heredado';

export interface CambioRegla {
  clave: ClaveRegla;
  etiqueta: string;
  tipo: TipoDeCambio;
  antes: unknown;
  despues: unknown;
  parametro: AnyRuleParameter;
  /** Nivel del que pasaria a heredarse, solo cuando el cambio es 'heredado'. */
  origenDestino: RuleSource | null;
}

/**
 * Que cambia respecto de lo que estaba guardado. Es la vista previa antes de
 * guardar y la confirmacion despues: sin esto el admin aprieta "guardar" a
 * ciegas sobre veinte parametros.
 */
export function resumirCambios(
  base: EstadoReglas,
  actual: EstadoReglas,
  editable: readonly AnyRuleParameter[],
): CambioRegla[] {
  const cambios: CambioRegla[] = [];

  for (const parametro of editable) {
    const antes = base[parametro.key];
    const despues = actual[parametro.key];
    if (!antes || !despues) continue;

    const comun = { clave: parametro.key, etiqueta: parametro.label, parametro };

    if (antes.propio && !despues.propio) {
      cambios.push({
        ...comun,
        tipo: 'heredado',
        antes: antes.valor,
        despues: despues.heredado,
        origenDestino: despues.origenHeredado,
      });
      continue;
    }

    if (!antes.propio && despues.propio) {
      cambios.push({
        ...comun,
        tipo: 'definido',
        antes: antes.heredado,
        despues: normalizarValor(parametro, despues.valor),
        origenDestino: null,
      });
      continue;
    }

    if (
      antes.propio &&
      despues.propio &&
      !mismoValor(normalizarValor(parametro, antes.valor), normalizarValor(parametro, despues.valor))
    ) {
      cambios.push({
        ...comun,
        tipo: 'ajustado',
        antes: antes.valor,
        despues: normalizarValor(parametro, despues.valor),
        origenDestino: null,
      });
    }
  }

  return cambios;
}

/** Comparacion suficiente para los tipos del catalogo (escalares y listas). */
export function mismoValor(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, indice) => item === b[indice]);
  }
  return a === b;
}

export interface GrupoDeReglas {
  grupo: string;
  etiqueta: string;
  parametros: readonly AnyRuleParameter[];
}

/**
 * Agrupa los parametros editables en el orden que declara el catalogo. Un grupo
 * desconocido no desaparece: cae en "Otras reglas", para que una regla nueva
 * nunca quede invisible por un despliegue a medias.
 */
export function agruparParaFormulario(
  editable: readonly AnyRuleParameter[],
  catalogo: CatalogoReglas,
): GrupoDeReglas[] {
  const grupos: GrupoDeReglas[] = [];
  const ubicados = new Set<string>();

  for (const grupo of catalogo.groups) {
    const parametros = editable.filter((parametro) => parametro.group === grupo);
    if (!parametros.length) continue;
    for (const parametro of parametros) ubicados.add(parametro.key);
    grupos.push({ grupo, etiqueta: catalogo.groupLabels[grupo] ?? grupo, parametros });
  }

  const sueltos = editable.filter((parametro) => !ubicados.has(parametro.key));
  if (sueltos.length) {
    grupos.push({ grupo: 'otros', etiqueta: 'Otras reglas', parametros: sueltos });
  }

  return grupos;
}

/** Valor que regira en terreno si se guarda tal como esta el formulario. */
export function valorResultante(campo: EstadoCampo): unknown {
  return campo.propio ? campo.valor : campo.heredado;
}

/** Cuantos parametros escribe este nivel. Es el titular de la pantalla. */
export function contarPropios(estado: EstadoReglas, editable: readonly AnyRuleParameter[]): number {
  return editable.filter((parametro) => estado[parametro.key]?.propio).length;
}

/**
 * Valor en lenguaje del cliente. Las unidades salen del catalogo
 * (`unitLabels`), nunca de una tabla escrita en la web.
 */
export function formatearValor(
  parametro: AnyRuleParameter,
  valor: unknown,
  unitLabels: Record<string, string>,
): string {
  switch (parametro.type) {
    case 'boolean':
      return valor ? 'Sí' : 'No';
    case 'integer': {
      const numero = Number(valor);
      if (!Number.isFinite(numero)) return 'sin valor';
      const texto = new Intl.NumberFormat('es-CL').format(numero);
      const unidad = parametro.unit ? unitLabels[parametro.unit] : null;
      return unidad ? `${texto} ${unidad}` : texto;
    }
    case 'email-list': {
      const correos = listaDeTexto(valor);
      return correos.length ? correos.join(', ') : 'sin destinatarios extra';
    }
    case 'multi-select': {
      const elegidas = listaDeTexto(valor);
      return elegidas.length ? elegidas.join(', ') : 'ninguna';
    }
    default:
      return String(valor);
  }
}

/** Texto de una linea para el resumen de cambios. */
export function frasesDelCambio(
  cambio: CambioRegla,
  unitLabels: Record<string, string>,
): string {
  const antes = formatearValor(cambio.parametro, cambio.antes, unitLabels);
  const despues = formatearValor(cambio.parametro, cambio.despues, unitLabels);

  if (cambio.tipo === 'heredado') {
    const origen = cambio.origenDestino ? deOrigen(cambio.origenDestino) : 'del nivel superior';
    return `vuelve a heredarse ${origen}: queda en ${despues} (acá decía ${antes})`;
  }
  if (cambio.tipo === 'definido') {
    return `queda fijada en este nivel: ${despues} (antes heredaba ${antes})`;
  }
  return `pasa de ${antes} a ${despues}`;
}
