import {
  LOGO_ALTO_MAXIMO_PX,
  LOGO_ANCHO_MAXIMO_PX,
  anchoParaCabecera,
  dimensionesDeImagen,
  resolverLogo,
} from './plantillas-logo';

/**
 * Se prueba con BYTES DE VERDAD y no con un mock del lector: lo que se quiere
 * verificar es justamente que la cabecera se interpreta bien, y un mock
 * devolveria lo que el autor ya cree.
 */

function png(ancho: number, alto: number): Buffer {
  const bytes = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(ancho, 16);
  bytes.writeUInt32BE(alto, 20);
  return bytes;
}

function gif(ancho: number, alto: number): Buffer {
  const bytes = Buffer.alloc(10);
  bytes.write('GIF89a', 0, 'ascii');
  bytes.writeUInt16LE(ancho, 6);
  bytes.writeUInt16LE(alto, 8);
  return bytes;
}

function jpeg(ancho: number, alto: number): Buffer {
  const bytes = Buffer.alloc(20);
  bytes.writeUInt16BE(0xffd8, 0);
  // Segmento APP0 vacio, para obligar al lector a recorrer y no a adivinar.
  bytes.writeUInt16BE(0xffe0, 2);
  bytes.writeUInt16BE(4, 4);
  bytes.writeUInt16BE(0xffc0, 8);
  bytes.writeUInt16BE(17, 10);
  bytes.writeUInt8(8, 12);
  bytes.writeUInt16BE(alto, 13);
  bytes.writeUInt16BE(ancho, 15);
  return bytes;
}

function dataUri(tipo: string, bytes: Buffer): string {
  return `data:${tipo};base64,${bytes.toString('base64')}`;
}

describe('dimensionesDeImagen', () => {
  it('lee PNG, GIF y JPEG desde su cabecera', () => {
    expect(dimensionesDeImagen(png(600, 200))).toEqual({ ancho: 600, alto: 200 });
    expect(dimensionesDeImagen(gif(320, 64))).toEqual({ ancho: 320, alto: 64 });
    expect(dimensionesDeImagen(jpeg(800, 400))).toEqual({ ancho: 800, alto: 400 });
  });

  it('devuelve null en vez de inventar cuando no reconoce el formato', () => {
    expect(dimensionesDeImagen(Buffer.from('no soy una imagen'))).toBeNull();
    expect(dimensionesDeImagen(Buffer.alloc(0))).toBeNull();
  });

  it('no se queda girando con un JPEG con largo de segmento invalido', () => {
    const roto = Buffer.alloc(12);
    roto.writeUInt16BE(0xffd8, 0);
    roto.writeUInt16BE(0xffe1, 2);
    // Largo 0: apunta hacia atras y dejaria el cursor sin avanzar.
    roto.writeUInt16BE(0, 4);
    expect(dimensionesDeImagen(roto)).toBeNull();
  });
});

describe('anchoParaCabecera', () => {
  it('achica el logo alto para que quepa en la cabecera', () => {
    // 800x400 escalado a 44 px de alto da 88 px de ancho.
    const ancho = anchoParaCabecera({ ancho: 800, alto: 400 });
    expect(ancho).toBe(Math.round((LOGO_ALTO_MAXIMO_PX / 400) * 800));
    expect(ancho).toBeLessThanOrEqual(LOGO_ANCHO_MAXIMO_PX);
  });

  it('nunca agranda un logo chico', () => {
    expect(anchoParaCabecera({ ancho: 60, alto: 20 })).toBe(60);
  });

  it('respeta el ancho maximo aunque el logo sea una franja', () => {
    expect(anchoParaCabecera({ ancho: 4000, alto: 40 })).toBe(LOGO_ANCHO_MAXIMO_PX);
  });

  it('sin dimensiones cae al ancho maximo y no a cero', () => {
    expect(anchoParaCabecera(null)).toBe(LOGO_ANCHO_MAXIMO_PX);
    expect(anchoParaCabecera({ ancho: 0, alto: 0 })).toBe(LOGO_ANCHO_MAXIMO_PX);
  });
});

describe('resolverLogo', () => {
  it('convierte el data URI en adjunto en linea con su ancho calculado', () => {
    const { logo, motivo } = resolverLogo(dataUri('image/png', png(600, 200)), 200);
    expect(motivo).toBeNull();
    expect(logo).toMatchObject({ modo: 'incrustado', contentType: 'image/png' });
    // 600x200 a 44 px de alto son 132 px de ancho.
    expect(logo?.modo === 'incrustado' ? logo.anchoPx : 0).toBe(132);
  });

  it('acepta https tal cual, sin adjuntar nada', () => {
    const { logo } = resolverLogo('https://cdn.example.cl/logo.png', 200);
    expect(logo).toEqual({
      modo: 'url',
      url: 'https://cdn.example.cl/logo.png',
      anchoPx: LOGO_ANCHO_MAXIMO_PX,
    });
  });

  it('rechaza http: el cliente de correo lo bloquea igual que el data URI', () => {
    expect(resolverLogo('http://cdn.example.cl/logo.png', 200).logo).toBeNull();
  });

  it('no incrusta webp porque Outlook no lo dibuja', () => {
    const { logo, motivo } = resolverLogo(dataUri('image/webp', png(100, 40)), 200);
    expect(logo).toBeNull();
    expect(motivo).toBe('formato_no_soportado');
  });

  it('deja fuera el logo que pasa el maximo configurado', () => {
    const pesado = dataUri('image/png', Buffer.concat([png(100, 40), Buffer.alloc(3000)]));
    expect(resolverLogo(pesado, 1)).toEqual({ logo: null, motivo: 'pesa_demasiado' });
    expect(resolverLogo(pesado, 64).logo).not.toBeNull();
  });

  it('sin logo configurado no es un error', () => {
    expect(resolverLogo(null, 200)).toEqual({ logo: null, motivo: 'sin_logo' });
    expect(resolverLogo('   ', 200)).toEqual({ logo: null, motivo: 'sin_logo' });
  });
});
