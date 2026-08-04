/**
 * El logo del tenant dentro del correo (#42).
 *
 * TRES COSAS QUE PARECEN DETALLE Y SON LA DIFERENCIA ENTRE "LLEVA SU MARCA" Y
 * "LLEGA UN CUADRADO ROTO":
 *
 * 1. Gmail y Outlook NO renderizan `src="data:image/png;base64,..."`. Lo bloquean
 *    los dos, por politica antimalware. Y `tenant_branding.logo_uri` guarda
 *    justamente un data URI (asi lo declara su migracion). Si se pega tal cual
 *    en el <img>, el correo del cliente muestra la marca rota en los dos
 *    clientes que el issue nombra. Por eso el data URI se convierte en un
 *    adjunto en linea con Content-ID y el <img> apunta a `cid:...`, que es lo
 *    unico que renderiza en todas partes.
 *
 * 2. WEBP no lo muestra Outlook (ni de escritorio ni el de Windows). Un logo
 *    webp incrustado se ve roto igual que el data URI, asi que no se incrusta:
 *    el correo sale con el nombre de la empresa en texto, que se lee siempre.
 *
 * 3. Outlook usa el motor de Word: respeta el atributo `width` y escala el alto
 *    en proporcion, pero ignora `max-height`. Si no se le da un ancho calculado,
 *    un logo cuadrado de 800x800 ocupa media pantalla. Por eso se leen las
 *    dimensiones reales de la cabecera del archivo y se calcula el ancho que
 *    deja el alto dentro del maximo de la maqueta.
 *
 * Leer la cabecera es barato y no necesita dependencia nueva: PNG, JPEG y GIF
 * declaran su tamaño en los primeros bytes.
 */

/** Alto maximo del logo en la cabecera del correo. Es maquetacion, no negocio. */
export const LOGO_ALTO_MAXIMO_PX = 44;
/** Ancho maximo del logo. El cuerpo del correo mide 600 px. */
export const LOGO_ANCHO_MAXIMO_PX = 200;

/** Content-ID del logo incrustado. Fijo: hay un solo logo por correo. */
export const LOGO_CONTENT_ID = 'marca-logo';

/** Tipos que renderizan tanto Gmail como Outlook como el correo del telefono. */
const TIPOS_SOPORTADOS = new Set(['image/png', 'image/jpeg', 'image/gif']);

const DATA_URI = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+=*)$/i;

export interface DimensionesImagen {
  readonly ancho: number;
  readonly alto: number;
}

/** El logo listo para el correo, ya resuelto a una de las formas que sirven. */
export type LogoCorreo =
  | {
      readonly modo: 'incrustado';
      readonly contentType: string;
      readonly contentBase64: string;
      readonly filename: string;
      readonly bytes: number;
      readonly anchoPx: number;
      /** El data URI original. Solo lo usa la vista previa del panel. */
      readonly dataUri: string;
    }
  | {
      readonly modo: 'url';
      readonly url: string;
      readonly anchoPx: number;
    };

/** Por que no se pudo incrustar. Se registra sin datos de nadie. */
export type MotivoSinLogo =
  | 'sin_logo'
  | 'formato_no_soportado'
  | 'pesa_demasiado'
  | 'uri_no_soportada';

export interface ResultadoLogo {
  readonly logo: LogoCorreo | null;
  readonly motivo: MotivoSinLogo | null;
}

/**
 * Resuelve `tenant_branding.logo_uri` a algo que un cliente de correo muestre.
 *
 * `maxKB` NO tiene default a proposito: es un parametro de negocio y vive en
 * rules.ts (`mailLogoMaxKB`). Ver INTEGRACION.md.
 */
export function resolverLogo(logoUri: string | null, maxKB: number): ResultadoLogo {
  const uri = (logoUri ?? '').trim();
  if (uri.length === 0) return { logo: null, motivo: 'sin_logo' };

  // Solo https: una imagen http la bloquean los clientes por contenido mixto y
  // el correo queda con el hueco igual que con el data URI.
  if (/^https:\/\//i.test(uri)) {
    return {
      logo: { modo: 'url', url: uri, anchoPx: LOGO_ANCHO_MAXIMO_PX },
      motivo: null,
    };
  }

  const match = DATA_URI.exec(uri);
  if (!match) return { logo: null, motivo: 'uri_no_soportada' };

  const contentType = (match[1] ?? '').toLowerCase();
  const base64 = match[2] ?? '';
  const normalizado = contentType === 'image/jpg' ? 'image/jpeg' : contentType;
  if (!TIPOS_SOPORTADOS.has(normalizado)) {
    return { logo: null, motivo: 'formato_no_soportado' };
  }

  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > maxKB * 1024) {
    return { logo: null, motivo: 'pesa_demasiado' };
  }

  return {
    logo: {
      modo: 'incrustado',
      contentType: normalizado,
      contentBase64: base64,
      filename: nombreDeArchivo(normalizado),
      bytes: bytes.length,
      anchoPx: anchoParaCabecera(dimensionesDeImagen(bytes)),
      dataUri: uri,
    },
    motivo: null,
  };
}

/**
 * Ancho en px con el que se dibuja el logo para que el alto no pase del maximo.
 *
 * Sin dimensiones legibles se usa el ancho maximo: es el peor caso conocido y
 * no el desastre de un logo a pantalla completa.
 */
export function anchoParaCabecera(dimensiones: DimensionesImagen | null): number {
  if (!dimensiones || dimensiones.ancho <= 0 || dimensiones.alto <= 0) {
    return LOGO_ANCHO_MAXIMO_PX;
  }
  const escalaPorAlto = LOGO_ALTO_MAXIMO_PX / dimensiones.alto;
  const anchoPorAlto = Math.round(dimensiones.ancho * escalaPorAlto);
  // Nunca se agranda un logo chico: ampliarlo lo deja pixelado.
  return Math.max(1, Math.min(anchoPorAlto, LOGO_ANCHO_MAXIMO_PX, dimensiones.ancho));
}

/** Dimensiones leidas de la cabecera del archivo. null si no se reconocen. */
export function dimensionesDeImagen(bytes: Buffer): DimensionesImagen | null {
  return dimensionesPng(bytes) ?? dimensionesGif(bytes) ?? dimensionesJpeg(bytes);
}

const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function dimensionesPng(bytes: Buffer): DimensionesImagen | null {
  if (bytes.length < 24) return null;
  if (!bytes.subarray(0, 8).equals(FIRMA_PNG)) return null;
  // IHDR es siempre el primer chunk: ancho en el byte 16 y alto en el 20.
  return { ancho: bytes.readUInt32BE(16), alto: bytes.readUInt32BE(20) };
}

function dimensionesGif(bytes: Buffer): DimensionesImagen | null {
  if (bytes.length < 10) return null;
  if (bytes.toString('ascii', 0, 4) !== 'GIF8') return null;
  // El descriptor logico de pantalla va en little endian.
  return { ancho: bytes.readUInt16LE(6), alto: bytes.readUInt16LE(8) };
}

/** Marcadores SOF de JPEG: los que declaran alto y ancho. */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function dimensionesJpeg(bytes: Buffer): DimensionesImagen | null {
  if (bytes.length < 4) return null;
  if (bytes.readUInt16BE(0) !== 0xffd8) return null;

  let cursor = 2;
  while (cursor + 3 < bytes.length) {
    if (bytes.readUInt8(cursor) !== 0xff) return null;

    const marcador = bytes.readUInt8(cursor + 1);
    // 0xFF de relleno entre segmentos: se avanza de a uno.
    if (marcador === 0xff) {
      cursor += 1;
      continue;
    }
    // Marcadores sin cuerpo (RSTn, SOI, EOI, TEM).
    if (marcador === 0x01 || (marcador >= 0xd0 && marcador <= 0xd9)) {
      cursor += 2;
      continue;
    }

    const largo = bytes.readUInt16BE(cursor + 2);
    // Un largo menor a 2 apunta hacia atras y dejaria el bucle girando.
    if (largo < 2) return null;
    if (SOF.has(marcador)) {
      if (cursor + 9 > bytes.length) return null;
      return { ancho: bytes.readUInt16BE(cursor + 7), alto: bytes.readUInt16BE(cursor + 5) };
    }
    cursor += 2 + largo;
  }
  return null;
}

function nombreDeArchivo(contentType: string): string {
  if (contentType === 'image/png') return 'logo.png';
  if (contentType === 'image/gif') return 'logo.gif';
  return 'logo.jpg';
}
