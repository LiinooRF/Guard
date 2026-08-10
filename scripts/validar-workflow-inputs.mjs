import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WORKFLOWS_DIR = new URL('../.github/workflows/', import.meta.url);
const INTERPOLACION_INPUT = /\$\{\{\s*inputs\./;
const RUN = /^(\s*)run\s*:/;

const fallos = [];

for (const nombre of readdirSync(WORKFLOWS_DIR).filter((archivo) => /\.ya?ml$/.test(archivo))) {
  const ruta = join(WORKFLOWS_DIR.pathname, nombre);
  const lineas = readFileSync(ruta, 'utf8').split(/\r?\n/);
  let indentacionRun = null;

  for (let indice = 0; indice < lineas.length; indice += 1) {
    const linea = lineas[indice] ?? '';
    const run = linea.match(RUN);
    if (run) {
      indentacionRun = run[1]?.length ?? 0;
      if (INTERPOLACION_INPUT.test(linea)) {
        fallos.push(`${nombre}:${indice + 1}`);
      }
      continue;
    }

    if (indentacionRun === null || !linea.trim()) continue;
    const indentacion = linea.match(/^\s*/)?.[0].length ?? 0;
    if (indentacion <= indentacionRun) {
      indentacionRun = null;
      continue;
    }
    if (INTERPOLACION_INPUT.test(linea)) {
      fallos.push(`${nombre}:${indice + 1}`);
    }
  }
}

if (fallos.length > 0) {
  console.error(
    `Los inputs de workflow deben pasar por env y tratarse como datos; interpolaciones inseguras: ${fallos.join(', ')}`,
  );
  process.exitCode = 1;
} else {
  console.log('Los bloques run no interpolan inputs de workflow.');
}
