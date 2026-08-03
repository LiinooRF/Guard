/**
 * Lectura de dimensiones directo de los bytes, sin dependencias nuevas.
 *
 * Cumple dos funciones: obtener width/height para la fila de scan_photos y
 * verificar que el CONTENIDO corresponde al mime declarado — la cabecera
 * multipart la escribe el cliente y no se le cree: un archivo renombrado a
 * .jpg no pasa.
 */

export interface Dimensiones {
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function leerDimensiones(buffer: Buffer, mimeType: string): Dimensiones | null {
  if (mimeType === 'image/png') return leerPng(buffer);
  if (mimeType === 'image/jpeg') return leerJpeg(buffer);
  return null;
}

/** Firma de 8 bytes + chunk IHDR: width y height van en offsets fijos. */
function leerPng(buffer: Buffer): Dimensiones | null {
  if (buffer.length < 24) return null;
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

/** Recorre los segmentos hasta el SOF, que trae las dimensiones del frame. */
function leerJpeg(buffer: Buffer): Dimensiones | null {
  if (buffer.length < 4 || buffer.readUInt16BE(0) !== 0xffd8) return null;

  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer.readUInt8(offset) !== 0xff) return null;
    const marker = buffer.readUInt8(offset + 1);

    // Relleno 0xFF y marcadores sin cuerpo (TEM, RSTn).
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9) return null; // EOI sin haber visto un SOF

    const esSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (esSof) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      if (width === 0 || height === 0) return null;
      return { width, height };
    }

    offset += 2 + buffer.readUInt16BE(offset + 2);
  }
  return null;
}
