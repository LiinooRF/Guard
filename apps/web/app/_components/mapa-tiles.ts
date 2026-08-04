/**
 * Origen de los tiles del mapa base (#75).
 *
 * Logica pura, sin React y sin Leaflet, para que se pueda probar con jest
 * —igual que `stats-charts-data.ts` y `reglas-catalogo.ts`— sin levantar un DOM.
 *
 * Aca vive la unica decision delicada del issue: DE DONDE salen las imagenes del
 * mapa. `tile.openstreetmap.org` es gratis y esta a un copiar-pegar de distancia,
 * y por eso mismo es la trampa: su politica de uso prohibe el trafico de
 * aplicaciones reales y bloquea al que la incumple. Un bloqueo no avisa: un dia
 * el panel de todos los clientes aparece en gris.
 *
 * Por eso el proveedor NO esta cableado en el codigo. Se configura por entorno y
 * el resolvedor falla CERRADO: si en produccion no hay proveedor propio, el mapa
 * se dibuja SIN fondo cartografico —los puntos y el recorrido se siguen viendo—
 * en vez de caer solo a los tiles publicos. Preferimos un mapa sin foto satelital
 * a que nos corten el servicio.
 *
 * Variables de entorno (van al bundle, por eso llevan NEXT_PUBLIC_):
 *
 *   NEXT_PUBLIC_MAP_TILES_URL          plantilla XYZ, ej https://tiles.midominio.cl/{z}/{x}/{y}.png
 *   NEXT_PUBLIC_MAP_TILES_ATTRIBUTION  atribucion del proveedor, ADEMAS de la de OSM
 *   NEXT_PUBLIC_MAP_TILES_MAX_ZOOM     hasta que zoom sirve el proveedor (default 19)
 */

/**
 * La atribucion a OpenStreetMap es OBLIGATORIA por licencia (ODbL) y va visible
 * sobre el mapa, no escondida en un "acerca de". No es una cortesia.
 */
export const ATRIBUCION_OSM = 'colaboradores de OpenStreetMap';
export const ENLACE_LICENCIA_OSM = 'https://www.openstreetmap.org/copyright';

/**
 * Tiles publicos de OSM. SOLO desarrollo, y con aviso a la vista para que nadie
 * los confunda con una configuracion terminada.
 */
export const TILES_PUBLICOS_OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

/** Hasta donde amplia un proveedor de tiles corriente. Es un dato del proveedor, no del negocio. */
export const MAX_ZOOM_POR_DEFECTO = 19;
const MAX_ZOOM_MINIMO = 1;
const MAX_ZOOM_MAXIMO = 22;

/**
 * Zoom de arranque cuando NO se puede encuadrar (un solo punto, o un recinto sin
 * puntos cargados). Con varios puntos no se usa: manda el encuadre.
 *
 * PROVISORIO: deberia salir de la regla configurable `mapDefaultZoom`; el
 * parametro exacto esta propuesto en INTEGRACION.md. Mientras tanto el
 * componente lo acepta por prop y esta constante es solo el ultimo recurso.
 */
export const ZOOM_INICIAL = 17;

/** Marcas que tiene que traer una plantilla XYZ para servir de algo. */
const MARCAS_OBLIGATORIAS = ['{z}', '{x}', '{y}'] as const;

/**
 * Dominios de los tiles publicos de OSM. Se comparan tambien los subdominios
 * (`a.tile.openstreetmap.org`), que es la forma clasica de colarse.
 */
const ANFITRIONES_OSM_PUBLICOS = [
  'tile.openstreetmap.org',
  'tiles.openstreetmap.org',
  'tile.osm.org',
] as const;

export type EstadoOrigenTiles =
  /** Proveedor propio o contratado. Lo normal en produccion. */
  | 'configurado'
  /** Tiles publicos de OSM. Solo fuera de produccion, y avisando. */
  | 'desarrollo'
  /** Produccion sin proveedor: el mapa va sin fondo. */
  | 'sin-configurar'
  /** Hay valor configurado pero no sirve. Se trata como si no hubiera. */
  | 'invalido';

export interface OrigenTiles {
  estado: EstadoOrigenTiles;
  /** `null` = el mapa se dibuja sin capa de fondo. Los puntos igual se ven. */
  url: string | null;
  maxZoom: number;
  /** Atribucion del proveedor, ADEMAS de la de OSM. `null` si no declaro ninguna. */
  atribucionProveedor: string | null;
  /** Texto para el jefe de operaciones. `null` cuando no hay nada que explicar. */
  aviso: string | null;
  /**
   * Motivo tecnico, para diagnostico. Nunca lleva datos de personas ni
   * coordenadas: solo describe la configuracion.
   */
  motivo: string | null;
}

export interface EntornoMapa {
  url?: string | undefined;
  atribucion?: string | undefined;
  maxZoom?: string | undefined;
  /** `process.env.NODE_ENV === 'production'`, resuelto por quien llama. */
  produccion: boolean;
}

const AVISO_DESARROLLO =
  'Estás viendo el mapa con los tiles públicos de OpenStreetMap, que solo sirven para pruebas. Antes de publicar hay que configurar el proveedor de mapas.';

const AVISO_SIN_CONFIGURAR =
  'El fondo del mapa no está configurado, así que se muestran solo los puntos y el recorrido. Pídele al equipo técnico que configure el proveedor de mapas.';

const AVISO_INVALIDO =
  'La dirección de los mapas quedó mal configurada, así que se muestran solo los puntos y el recorrido. Avísale al equipo técnico.';

const AVISO_OSM_EN_PRODUCCION =
  'El mapa está configurado con los tiles públicos de OpenStreetMap, que no se pueden usar en producción: bloquean el servicio. Se muestran solo los puntos hasta que se configure un proveedor.';

/**
 * Resuelve de donde salen los tiles. Funcion pura: recibe el entorno ya leido,
 * porque `process.env.NEXT_PUBLIC_*` solo se reemplaza al compilar cuando se
 * escribe literal, y eso tiene que pasar en el componente, no aca.
 */
export function resolverOrigenTiles(entorno: EntornoMapa): OrigenTiles {
  const maxZoom = leerMaxZoom(entorno.maxZoom);
  const atribucionProveedor = limpiar(entorno.atribucion);
  const plantilla = limpiar(entorno.url);

  if (plantilla === null) {
    if (entorno.produccion) {
      return {
        estado: 'sin-configurar',
        url: null,
        maxZoom,
        atribucionProveedor,
        aviso: AVISO_SIN_CONFIGURAR,
        motivo: 'NEXT_PUBLIC_MAP_TILES_URL no esta definida',
      };
    }
    return {
      estado: 'desarrollo',
      url: TILES_PUBLICOS_OSM,
      maxZoom,
      atribucionProveedor,
      aviso: AVISO_DESARROLLO,
      motivo: 'sin proveedor configurado, se usan los tiles publicos de OSM',
    };
  }

  const faltantes = MARCAS_OBLIGATORIAS.filter((marca) => !plantilla.includes(marca));
  if (faltantes.length > 0) {
    return invalido(maxZoom, atribucionProveedor, `la plantilla no trae ${faltantes.join(', ')}`);
  }

  const anfitrion = anfitrionDe(plantilla);
  if (anfitrion === null) {
    return invalido(maxZoom, atribucionProveedor, 'la plantilla no es una URL valida');
  }

  // http mezclado en una pagina https lo bloquea el navegador y el mapa queda en
  // blanco sin decir por que. En desarrollo se deja pasar (tiles locales).
  if (!plantilla.toLowerCase().startsWith('https://') && entorno.produccion) {
    return invalido(maxZoom, atribucionProveedor, 'la plantilla no usa https');
  }

  if (esOsmPublico(anfitrion)) {
    if (entorno.produccion) {
      return {
        estado: 'invalido',
        url: null,
        maxZoom,
        atribucionProveedor,
        aviso: AVISO_OSM_EN_PRODUCCION,
        motivo: 'los tiles publicos de OSM no se pueden usar en produccion',
      };
    }
    return {
      estado: 'desarrollo',
      url: plantilla,
      maxZoom,
      atribucionProveedor,
      aviso: AVISO_DESARROLLO,
      motivo: 'tiles publicos de OSM, solo desarrollo',
    };
  }

  return {
    estado: 'configurado',
    url: plantilla,
    maxZoom,
    atribucionProveedor,
    aviso: null,
    motivo: null,
  };
}

function invalido(
  maxZoom: number,
  atribucionProveedor: string | null,
  motivo: string,
): OrigenTiles {
  return {
    estado: 'invalido',
    url: null,
    maxZoom,
    atribucionProveedor,
    aviso: AVISO_INVALIDO,
    motivo,
  };
}

function limpiar(valor: string | undefined): string | null {
  const texto = (valor ?? '').trim();
  return texto.length > 0 ? texto : null;
}

function leerMaxZoom(valor: string | undefined): number {
  const numero = Number.parseInt((valor ?? '').trim(), 10);
  if (!Number.isFinite(numero)) return MAX_ZOOM_POR_DEFECTO;
  if (numero < MAX_ZOOM_MINIMO || numero > MAX_ZOOM_MAXIMO) return MAX_ZOOM_POR_DEFECTO;
  return numero;
}

/** `null` cuando la plantilla no es una URL que el navegador pueda pedir. */
function anfitrionDe(plantilla: string): string | null {
  try {
    const url = new URL(plantilla);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function esOsmPublico(anfitrion: string): boolean {
  return ANFITRIONES_OSM_PUBLICOS.some(
    (base) => anfitrion === base || anfitrion.endsWith(`.${base}`),
  );
}
