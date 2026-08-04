import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decodificarDataUri,
  leerEvidencia,
  leerLogoMarca,
  rutaSegura,
} from './evidence-reader';

/**
 * La promesa que verifican estos tests: una foto que falta, que esta truncada o
 * que alguien reemplazo por basura NO puede tumbar el informe entero. Se
 * devuelve un motivo y el anexo dibuja el hueco marcado.
 */

/** PNG minimo valido para leerDimensiones: firma + cabecera IHDR. */
function pngMinimo(ancho = 8, alto = 6): Buffer {
  const cabecera = Buffer.alloc(16);
  cabecera.writeUInt32BE(13, 0);
  cabecera.write('IHDR', 4, 'ascii');
  cabecera.writeUInt32BE(ancho, 8);
  cabecera.writeUInt32BE(alto, 12);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    cabecera,
  ]);
}

/** JPEG minimo valido: SOI + un segmento SOF0 con las dimensiones. */
function jpegMinimo(ancho = 8, alto = 6): Buffer {
  const buffer = Buffer.alloc(20);
  buffer.writeUInt16BE(0xffd8, 0);
  buffer.writeUInt8(0xff, 2);
  buffer.writeUInt8(0xc0, 3);
  buffer.writeUInt16BE(17, 4);
  buffer.writeUInt8(8, 6);
  buffer.writeUInt16BE(alto, 7);
  buffer.writeUInt16BE(ancho, 9);
  return buffer;
}

const OPCIONES = { maxBytes: 1024 * 1024 };

describe('leerEvidencia', () => {
  let raiz: string;

  beforeEach(async () => {
    raiz = await mkdtemp(join(tmpdir(), 'voxia-evidencia-'));
    await mkdir(join(raiz, 'tenant', 'ronda'), { recursive: true });
  });

  afterEach(async () => {
    await rm(raiz, { recursive: true, force: true });
  });

  it('lee una foto que existe', async () => {
    await writeFile(join(raiz, 'tenant', 'ronda', 'ok.jpg'), jpegMinimo());

    const lectura = await leerEvidencia(raiz, 'tenant/ronda/ok.jpg', 'image/jpeg', OPCIONES);

    expect(lectura.ok).toBe(true);
    if (lectura.ok) expect(lectura.contenido.length).toBe(20);
  });

  it('la foto que falta devuelve motivo, no una excepción', async () => {
    const lectura = await leerEvidencia(raiz, 'tenant/ronda/fantasma.jpg', 'image/jpeg', OPCIONES);

    expect(lectura).toEqual({ ok: false, motivo: 'no_encontrada' });
  });

  it('la foto corrupta se descarta antes de que pdfkit intente embeberla', async () => {
    // Cabecera valida, cuerpo que no es una imagen: si esto llegara a
    // doc.image() reventaria y se llevaria el informe completo.
    await writeFile(join(raiz, 'tenant', 'ronda', 'rota.jpg'), Buffer.from('esto no es un jpeg'));

    const lectura = await leerEvidencia(raiz, 'tenant/ronda/rota.jpg', 'image/jpeg', OPCIONES);

    expect(lectura).toEqual({ ok: false, motivo: 'ilegible' });
  });

  it('el archivo vacío se trata como ilegible', async () => {
    await writeFile(join(raiz, 'tenant', 'ronda', 'vacia.jpg'), Buffer.alloc(0));

    const lectura = await leerEvidencia(raiz, 'tenant/ronda/vacia.jpg', 'image/jpeg', OPCIONES);

    expect(lectura).toEqual({ ok: false, motivo: 'ilegible' });
  });

  it('no carga en memoria un archivo por sobre el máximo del tenant', async () => {
    await writeFile(join(raiz, 'tenant', 'ronda', 'gorda.jpg'), Buffer.alloc(5000, 1));

    const lectura = await leerEvidencia(raiz, 'tenant/ronda/gorda.jpg', 'image/jpeg', {
      maxBytes: 1000,
    });

    expect(lectura).toEqual({ ok: false, motivo: 'demasiado_grande' });
  });

  it('rechaza un mime que pdfkit no sabe embeber', async () => {
    const lectura = await leerEvidencia(raiz, 'tenant/ronda/ok.jpg', 'image/webp', OPCIONES);

    expect(lectura).toEqual({ ok: false, motivo: 'formato_no_soportado' });
  });

  it('una ruta que escapa del volumen no se lee', async () => {
    const lectura = await leerEvidencia(raiz, '../../etc/passwd', 'image/jpeg', OPCIONES);

    expect(lectura).toEqual({ ok: false, motivo: 'ruta_invalida' });
  });

  it('un directorio en vez de un archivo no se lee', async () => {
    const lectura = await leerEvidencia(raiz, 'tenant/ronda', 'image/jpeg', OPCIONES);

    expect(lectura).toEqual({ ok: false, motivo: 'no_encontrada' });
  });
});

describe('rutaSegura', () => {
  it('acepta una ruta relativa dentro de la raíz', () => {
    expect(rutaSegura('/vol/evidencia', 'tenant/ronda/a.jpg')).not.toBeNull();
  });

  it('rechaza rutas absolutas, vacías, con .. o con byte nulo', () => {
    expect(rutaSegura('/vol/evidencia', '/etc/passwd')).toBeNull();
    expect(rutaSegura('/vol/evidencia', '')).toBeNull();
    expect(rutaSegura('/vol/evidencia', '../fuera.jpg')).toBeNull();
    expect(rutaSegura('/vol/evidencia', 'tenant/../../fuera.jpg')).toBeNull();
    expect(rutaSegura('/vol/evidencia', 'tenant/a\0.jpg')).toBeNull();
  });

  it('no acepta un hermano cuyo nombre empieza igual que la raíz', () => {
    // /vol/evidencia-vieja NO esta dentro de /vol/evidencia.
    expect(rutaSegura('/vol/evidencia', '../evidencia-vieja/a.jpg')).toBeNull();
  });
});

describe('decodificarDataUri', () => {
  it('decodifica un PNG en base64', () => {
    const uri = `data:image/png;base64,${pngMinimo(12, 9).toString('base64')}`;
    const logo = decodificarDataUri(uri, OPCIONES.maxBytes);

    expect(logo).not.toBeNull();
    expect(logo!.length).toBe(24);
  });

  it('rechaza SVG: pdfkit no lo dibuja y puede traer scripts adentro', () => {
    const uri = `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`;
    expect(decodificarDataUri(uri, OPCIONES.maxBytes)).toBeNull();
  });

  it('rechaza contenido que no corresponde al mime declarado', () => {
    const uri = `data:image/png;base64,${Buffer.from('no soy un png').toString('base64')}`;
    expect(decodificarDataUri(uri, OPCIONES.maxBytes)).toBeNull();
  });

  it('rechaza un data URI mal formado o sin base64', () => {
    expect(decodificarDataUri('data:image/png,abc', OPCIONES.maxBytes)).toBeNull();
    expect(decodificarDataUri('data:image/png;base64', OPCIONES.maxBytes)).toBeNull();
    expect(decodificarDataUri('https://cdn.example/logo.png', OPCIONES.maxBytes)).toBeNull();
  });

  it('descarta por tamaño antes de decodificar', () => {
    const uri = `data:image/png;base64,${'A'.repeat(4000)}`;
    expect(decodificarDataUri(uri, 100)).toBeNull();
  });
});

describe('leerLogoMarca', () => {
  let raiz: string;

  beforeEach(async () => {
    raiz = await mkdtemp(join(tmpdir(), 'voxia-logo-'));
  });

  afterEach(async () => {
    await rm(raiz, { recursive: true, force: true });
  });

  it('sin logo devuelve null y el informe sale con el nombre del cliente', async () => {
    expect(await leerLogoMarca(null, raiz, OPCIONES)).toBeNull();
    expect(await leerLogoMarca('', raiz, OPCIONES)).toBeNull();
  });

  it('lee el logo guardado como archivo en el volumen', async () => {
    await writeFile(join(raiz, 'logo.png'), pngMinimo());

    expect(await leerLogoMarca('logo.png', raiz, OPCIONES)).not.toBeNull();
  });

  it('un logo borrado del volumen no tumba el informe', async () => {
    expect(await leerLogoMarca('no-existe.png', raiz, OPCIONES)).toBeNull();
  });
});
