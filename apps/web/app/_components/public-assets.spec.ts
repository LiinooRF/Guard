import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const PUBLIC_DIR = join(__dirname, '..', '..', 'public');
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
  /\bcredenciales?\b/i,
  /\b(?:password|passwd|contrase(?:n|ñ)a)\b/i,
  /\b(?:api[_-]?key|private[_-]?key|secret[oa]?)\b/i,
];

function archivosPublicos(carpeta: string): string[] {
  return readdirSync(carpeta).flatMap((entrada) => {
    const ruta = join(carpeta, entrada);
    return statSync(ruta).isDirectory() ? archivosPublicos(ruta) : [ruta];
  });
}

describe('assets publicos', () => {
  it('no publica artefactos operativos ni archivos habituales de secretos', () => {
    const prohibidos = archivosPublicos(PUBLIC_DIR)
      .filter((ruta) => EXTENSIONES_OPERATIVAS.has(extname(ruta).toLowerCase()))
      .map((ruta) => relative(PUBLIC_DIR, ruta))
      .sort();

    expect(prohibidos).toEqual([]);
  });

  it('no contiene marcadores habituales de credenciales', () => {
    const hallazgos = archivosPublicos(PUBLIC_DIR)
      .filter((ruta) => {
        const contenido = readFileSync(ruta);
        if (contenido.includes(0)) return false;
        const texto = contenido.toString('utf8');
        return MARCADORES_DE_CREDENCIALES.some((patron) => patron.test(texto));
      })
      .map((ruta) => relative(PUBLIC_DIR, ruta))
      .sort();

    expect(hallazgos).toEqual([]);
  });
});
