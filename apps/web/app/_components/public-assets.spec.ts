import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const PUBLIC_DIR = join(__dirname, '..', '..', 'public');
const ASSETS_PUBLICOS_APROBADOS = new Set(['sw-tiles.js']);
const EXTENSIONES_OPERATIVAS = new Set([
  '.csv',
  '.env',
  '.key',
  '.log',
  '.md',
  '.p12',
  '.pem',
  '.pfx',
  '.sql',
  '.txt',
]);
const MARCADORES_DE_CREDENCIALES = [
  /\b(?:clave|credenciales?)\b/i,
  /\b(?:password|passwd|contrase(?:n|ñ)a)\b/i,
  /\b(?:access[_-]?token|api[_-]?key|authorization|bearer|client[_-]?secret)\b/i,
  /\b(?:private[_-]?key|refresh[_-]?token|secret[oa]?|token)\b/i,
];

function contieneMarcadorDeCredencial(contenido: Buffer): boolean {
  const texto = contenido.toString('utf8').replaceAll('\0', '');
  return MARCADORES_DE_CREDENCIALES.some((patron) => patron.test(texto));
}

function archivosPublicos(carpeta: string): string[] {
  return readdirSync(carpeta).flatMap((entrada) => {
    const ruta = join(carpeta, entrada);
    return statSync(ruta).isDirectory() ? archivosPublicos(ruta) : [ruta];
  });
}

describe('assets publicos', () => {
  it('solo publica assets revisados de forma explicita', () => {
    const noAprobados = archivosPublicos(PUBLIC_DIR)
      .map((ruta) => relative(PUBLIC_DIR, ruta))
      .filter((ruta) => !ASSETS_PUBLICOS_APROBADOS.has(ruta))
      .sort();

    expect(noAprobados).toEqual([]);
  });

  it('no publica artefactos operativos ni archivos habituales de secretos', () => {
    const prohibidos = archivosPublicos(PUBLIC_DIR)
      .filter((ruta) => EXTENSIONES_OPERATIVAS.has(extname(ruta).toLowerCase()))
      .map((ruta) => relative(PUBLIC_DIR, ruta))
      .sort();

    expect(prohibidos).toEqual([]);
  });

  it('no contiene marcadores habituales de credenciales', () => {
    const hallazgos = archivosPublicos(PUBLIC_DIR)
      .filter((ruta) => contieneMarcadorDeCredencial(readFileSync(ruta)))
      .map((ruta) => relative(PUBLIC_DIR, ruta))
      .sort();

    expect(hallazgos).toEqual([]);
  });

  it.each([
    'CREDENCIALES de prueba',
    'clave=valor',
    '{"accessToken":"valor"}',
    'Authorization: Bearer valor',
    'pass\0word=valor',
  ])('detecta el marcador sensible incluso en otro formato: %s', (contenido) => {
    expect(contieneMarcadorDeCredencial(Buffer.from(contenido))).toBe(true);
  });
});
