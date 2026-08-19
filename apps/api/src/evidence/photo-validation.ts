import { PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { createHash } from 'node:crypto';

import { leerDimensiones } from './image-format';

/**
 * Subconjunto del archivo que entrega FileInterceptor (multer). Se declara aca
 * para no depender de @types/multer: esta es toda la superficie que se usa.
 */
export interface FotoSubida {
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const MIME_PERMITIDOS: readonly string[] = ['image/jpeg', 'image/png'];

export interface ImagenValidada {
  readonly width: number;
  readonly height: number;
  readonly sha256: string;
  readonly extension: 'jpg' | 'png';
}

/**
 * Validacion comun a toda la evidencia fotografica, sea de escaneo o de
 * novedad: formato, contenido y tamaño maximo del tenant.
 *
 * El formato se comprueba POR CONTENIDO y no por el mime declarado: el
 * encabezado lo manda el cliente y renombrar un archivo es gratis. leerDimensiones
 * devuelve null si los bytes no corresponden al formato que dice ser.
 *
 * El maximo NO es un numero fijo aca: llega desde las reglas del tenant
 * (photoMaxSizeMB). El limite del interceptor es otra cosa —un techo anti-DoS
 * para no bufferizar subidas gigantes— y es siempre mayor o igual que este.
 */
export function validarImagen(archivo: FotoSubida, maxSizeMB: number): ImagenValidada {
  if (!MIME_PERMITIDOS.includes(archivo.mimetype)) {
    throw new UnsupportedMediaTypeException('Solo se acepta evidencia image/jpeg o image/png');
  }
  const dimensiones = leerDimensiones(archivo.buffer, archivo.mimetype);
  if (!dimensiones) {
    throw new UnsupportedMediaTypeException(
      'El contenido del archivo no corresponde al formato declarado',
    );
  }
  const pesoRealBytes = Math.max(archivo.size, archivo.buffer.length);
  if (pesoRealBytes > maxSizeMB * 1024 * 1024) {
    throw new PayloadTooLargeException(
      `La foto supera el maximo de ${maxSizeMB} MB configurado para el tenant`,
    );
  }
  return {
    width: dimensiones.width,
    height: dimensiones.height,
    sha256: createHash('sha256').update(archivo.buffer).digest('hex'),
    extension: archivo.mimetype === 'image/png' ? 'png' : 'jpg',
  };
}
