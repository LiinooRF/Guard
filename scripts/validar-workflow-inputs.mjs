import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const WORKFLOWS_DIR = fileURLToPath(new URL('../.github/workflows/', import.meta.url));
const INTERPOLACION_INPUT =
  /\$\{\{[\s\S]*?\b(?:github\.event\.)?inputs\s*(?:\.|\[)/;
const RUN = /^(\s*)(?:-\s*)?(?:"run"|'run'|run)\s*:(.*)$/;

export function interpolacionesInseguras(contenido, nombre = 'workflow.yml') {
  const lineas = contenido.split(/\r?\n/);
  const fallos = [];
  let bloqueRun = null;

  const cerrarBloque = () => {
    if (!bloqueRun) return;
    if (INTERPOLACION_INPUT.test(bloqueRun.contenido.join('\n'))) {
      fallos.push(`${nombre}:${bloqueRun.linea}`);
    }
    bloqueRun = null;
  };

  for (let indice = 0; indice < lineas.length; indice += 1) {
    const linea = lineas[indice] ?? '';

    if (bloqueRun) {
      const indentacion = linea.match(/^\s*/)?.[0].length ?? 0;
      if (!linea.trim() || indentacion > bloqueRun.indentacion) {
        bloqueRun.contenido.push(linea);
        continue;
      }
      cerrarBloque();
    }

    const run = linea.match(RUN);
    if (run) {
      bloqueRun = {
        linea: indice + 1,
        indentacion: run[1]?.length ?? 0,
        contenido: [run[2] ?? ''],
      };
    }
  }

  cerrarBloque();
  return fallos;
}

export function validarDirectorio(workflowsDir = WORKFLOWS_DIR) {
  return readdirSync(workflowsDir)
    .filter((archivo) => /\.ya?ml$/.test(archivo))
    .flatMap((nombre) => {
      const ruta = join(workflowsDir, nombre);
      return interpolacionesInseguras(readFileSync(ruta, 'utf8'), nombre);
    });
}

export function main() {
  const fallos = validarDirectorio();
  if (fallos.length > 0) {
    console.error(
      `Los inputs de workflow deben pasar por env y tratarse como datos; interpolaciones inseguras: ${fallos.join(', ')}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log('Los bloques run no interpolan inputs de workflow.');
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
