import { PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { type FotoSubida, validarImagen } from './photo-validation';

/** PNG minimo valido: firma de 8 bytes + chunk IHDR de 13 bytes (640x480). */
function bufferPngValido(ancho = 640, alto = 480): Buffer {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(ancho, 16);
  buffer.writeUInt32BE(alto, 20);
  return buffer;
}

/** JPEG minimo valido: SOI (0xFFD8) + SOF0 (0xFFC0 con 640x480). */
function bufferJpegValido(ancho = 640, alto = 480): Buffer {
  const buffer = Buffer.alloc(13);
  buffer.writeUInt16BE(0xffd8, 0); // SOI
  buffer.writeUInt8(0xff, 2);
  buffer.writeUInt8(0xc0, 3); // SOF0
  buffer.writeUInt16BE(9, 4); // Longitud del segmento SOF
  buffer.writeUInt8(8, 6); // Precision
  buffer.writeUInt16BE(alto, 7); // Alto
  buffer.writeUInt16BE(ancho, 9); // Ancho
  buffer.writeUInt8(3, 11); // Componentes
  buffer.writeUInt8(0, 12);
  return buffer;
}

describe('validarImagen', () => {
  it('acepta y valida un PNG con dimensiones, sha256 y extension png', () => {
    const buffer = bufferPngValido(800, 600);
    const archivo: FotoSubida = {
      mimetype: 'image/png',
      size: buffer.length,
      buffer,
    };

    const resultado = validarImagen(archivo, 5);
    expect(resultado).toMatchObject({
      width: 800,
      height: 600,
      extension: 'png',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('acepta y valida un JPEG con dimensiones, sha256 y extension jpg', () => {
    const buffer = bufferJpegValido(1024, 768);
    const archivo: FotoSubida = {
      mimetype: 'image/jpeg',
      size: buffer.length,
      buffer,
    };

    const resultado = validarImagen(archivo, 5);
    expect(resultado).toMatchObject({
      width: 1024,
      height: 768,
      extension: 'jpg',
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it('rechaza tipos MIME no permitidos (ej. gif, webp, pdf)', () => {
    const buffer = bufferPngValido();
    expect(() =>
      validarImagen({ mimetype: 'image/gif', size: buffer.length, buffer }, 5),
    ).toThrow(UnsupportedMediaTypeException);

    expect(() =>
      validarImagen({ mimetype: 'image/webp', size: buffer.length, buffer }, 5),
    ).toThrow(UnsupportedMediaTypeException);

    expect(() =>
      validarImagen({ mimetype: 'application/pdf', size: buffer.length, buffer }, 5),
    ).toThrow(UnsupportedMediaTypeException);
  });

  it('rechaza contenido falso o corrompido que no coincide con el MIME declarado', () => {
    const falsoJpeg: FotoSubida = {
      mimetype: 'image/jpeg',
      size: 30,
      buffer: Buffer.from('esto no es una imagen jpeg'),
    };
    expect(() => validarImagen(falsoJpeg, 5)).toThrow(
      'El contenido del archivo no corresponde al formato declarado',
    );

    const falsoPng: FotoSubida = {
      mimetype: 'image/png',
      size: 30,
      buffer: Buffer.from('esto no es una imagen png'),
    };
    expect(() => validarImagen(falsoPng, 5)).toThrow(
      'El contenido del archivo no corresponde al formato declarado',
    );
  });

  it('rechaza cuando el tamaño declarado supera el limite del tenant', () => {
    const buffer = bufferPngValido();
    const archivo: FotoSubida = {
      mimetype: 'image/png',
      size: 6 * 1024 * 1024, // 6 MB declarado
      buffer,
    };
    expect(() => validarImagen(archivo, 5)).toThrow(PayloadTooLargeException);
  });

  it('rechaza cuando el buffer real supera el limite aunque el campo size declare un valor menor', () => {
    const bufferGrande = Buffer.alloc(3 * 1024 * 1024);
    bufferPngValido().copy(bufferGrande, 0);

    const archivoManipulado: FotoSubida = {
      mimetype: 'image/png',
      size: 50, // Falso
      buffer: bufferGrande,
    };
    expect(() => validarImagen(archivoManipulado, 2)).toThrow(PayloadTooLargeException);
  });
});
