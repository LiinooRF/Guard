import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

import { leerDimensiones } from '../evidence/image-format';

/**
 * Lectura tolerante del volumen de evidencia para el anexo fotografico (#85).
 *
 * Regla del issue: una foto faltante o corrupta NO puede tumbar la generacion
 * del informe entero. Una ronda de 40 puntos con una imagen truncada por un
 * corte de disco tiene que salir igual, con ese recuadro marcado como evidencia
 * no disponible — un informe que no se genera no le sirve a nadie.
 *
 * Por eso nada de esto lanza: devuelve un resultado con motivo.
 */

export type MotivoEvidencia =
  | 'ruta_invalida'
  | 'no_encontrada'
  | 'demasiado_grande'
  | 'formato_no_soportado'
  | 'ilegible';

export const MOTIVO_TEXTO: Record<MotivoEvidencia, string> = {
  ruta_invalida: 'Ruta de evidencia inválida',
  no_encontrada: 'Archivo no encontrado en el volumen',
  demasiado_grande: 'Archivo por sobre el máximo permitido',
  formato_no_soportado: 'Formato no soportado',
  ilegible: 'Archivo ilegible o dañado',
};

export type LecturaEvidencia =
  | { readonly ok: true; readonly contenido: Buffer }
  | { readonly ok: false; readonly motivo: MotivoEvidencia };

/** pdfkit solo embebe JPEG y PNG, que son los unicos mime que acepta #13. */
const MIME_SOPORTADOS: readonly string[] = ['image/jpeg', 'image/png'];

export interface OpcionesLectura {
  /** Techo de bytes por archivo. Un archivo mayor se salta en vez de cargarlo. */
  readonly maxBytes: number;
}

/**
 * Lee UNA foto del volumen de evidencia.
 *
 * `rutaRelativa` es lo guardado en scan_photos.storage_path (tenant/ronda/sha.ext).
 * Aunque la escribe el servidor, se valida la contencion dentro de la raiz: si
 * alguna vez esa columna se pudiera influir desde afuera, un "../../etc/passwd"
 * terminaria embebido dentro de un PDF que el cliente descarga.
 */
export async function leerEvidencia(
  raiz: string,
  rutaRelativa: string,
  mimeType: string,
  opciones: OpcionesLectura,
): Promise<LecturaEvidencia> {
  if (!MIME_SOPORTADOS.includes(mimeType)) {
    return { ok: false, motivo: 'formato_no_soportado' };
  }

  const ruta = rutaSegura(raiz, rutaRelativa);
  if (ruta === null) return { ok: false, motivo: 'ruta_invalida' };

  try {
    const info = await stat(ruta);
    if (!info.isFile()) return { ok: false, motivo: 'no_encontrada' };
    // El tamaño se consulta ANTES de leer: el punto de todo el ejercicio es no
    // cargar en memoria un archivo que no vamos a poder manejar.
    if (info.size > opciones.maxBytes) return { ok: false, motivo: 'demasiado_grande' };
    if (info.size === 0) return { ok: false, motivo: 'ilegible' };

    const contenido = await readFile(ruta);
    // Se verifica el CONTENIDO contra el mime declarado, igual que al subir la
    // foto: un archivo truncado a la mitad tiene cabecera valida pero pdfkit
    // revienta al embeberlo, y ese error se lleva el informe completo.
    if (leerDimensiones(contenido, mimeType) === null) {
      return { ok: false, motivo: 'ilegible' };
    }
    return { ok: true, contenido };
  } catch (error) {
    if (esNoEncontrado(error)) return { ok: false, motivo: 'no_encontrada' };
    return { ok: false, motivo: 'ilegible' };
  }
}

/**
 * El logo del tenant para la cabecera. `logoUri` admite dos formas (ver la
 * migracion 1724857200000-CreateTenantBranding): data URI o ruta relativa en el
 * volumen de evidencia. Cualquier problema devuelve null y el informe sale con
 * el nombre del cliente pero sin logo.
 */
export async function leerLogoMarca(
  logoUri: string | null,
  raiz: string,
  opciones: OpcionesLectura,
): Promise<Buffer | null> {
  if (!logoUri) return null;

  if (logoUri.startsWith('data:')) {
    const decodificado = decodificarDataUri(logoUri, opciones.maxBytes);
    return decodificado;
  }

  const lectura = await leerEvidencia(raiz, logoUri, mimeDesdeExtension(logoUri), opciones);
  return lectura.ok ? lectura.contenido : null;
}

/**
 * Decodifica un data URI de imagen. Solo PNG y JPEG: un SVG de marca —que es lo
 * que suele entregar un diseñador— pdfkit no lo sabe dibujar, y ademas puede
 * traer scripts y referencias externas dentro.
 */
export function decodificarDataUri(uri: string, maxBytes: number): Buffer | null {
  const separador = uri.indexOf(',');
  if (separador < 0) return null;

  const cabecera = uri.slice(5, separador);
  if (!cabecera.endsWith(';base64')) return null;

  const mime = cabecera.slice(0, -';base64'.length);
  if (!MIME_SOPORTADOS.includes(mime)) return null;

  const base64 = uri.slice(separador + 1);
  // 4 caracteres base64 son 3 bytes: se descarta por longitud antes de decodificar.
  if ((base64.length * 3) / 4 > maxBytes) return null;

  try {
    const contenido = Buffer.from(base64, 'base64');
    if (contenido.length === 0) return null;
    if (leerDimensiones(contenido, mime) === null) return null;
    return contenido;
  } catch {
    return null;
  }
}

/**
 * Resuelve la ruta y confirma que queda DENTRO de la raiz de evidencia.
 * Devuelve null si la ruta es absoluta, escapa con `..` o esta vacia.
 */
export function rutaSegura(raiz: string, rutaRelativa: string): string | null {
  if (!rutaRelativa || isAbsolute(rutaRelativa)) return null;
  if (rutaRelativa.includes('\0')) return null;

  const raizAbsoluta = resolve(raiz);
  const destino = resolve(raizAbsoluta, rutaRelativa);
  const prefijo = raizAbsoluta.endsWith(sep) ? raizAbsoluta : raizAbsoluta + sep;
  if (!destino.startsWith(prefijo)) return null;
  return destino;
}

function mimeDesdeExtension(ruta: string): string {
  return ruta.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
}

function esNoEncontrado(error: unknown): boolean {
  const codigo = (error as { code?: string } | null)?.code;
  return codigo === 'ENOENT' || codigo === 'ENOTDIR';
}
