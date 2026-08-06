import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Los documentos que el codigo manda a leer tienen que existir.
 *
 * `mapa-base.tsx` decia "el proveedor elegido y sus costos estan en
 * `docs/decisions/0002-proveedor-de-tiles-del-mapa.md`" y ese archivo **no
 * existia**. Quien lo leyera concluiria que la decision ya se tomo — cuando en
 * realidad `MAP_TILE_URL` estaba vacio y el mapa salia sin fondo en produccion.
 *
 * Una referencia rota a documentacion no rompe el build ni ningun test, y por eso
 * sobrevive: solo se nota cuando alguien va a buscar el documento y no esta. Para
 * entonces ya tomo una decision con informacion falsa.
 */
const RAIZ = join(__dirname, '..', '..', '..', '..');

function archivosDeCodigo(carpeta: string): string[] {
  const encontrados: string[] = [];
  for (const entrada of readdirSync(carpeta)) {
    if (entrada === 'node_modules' || entrada === '.next' || entrada.startsWith('.')) continue;
    const ruta = join(carpeta, entrada);
    if (statSync(ruta).isDirectory()) {
      encontrados.push(...archivosDeCodigo(ruta));
    } else if (/\.(ts|tsx)$/.test(entrada)) {
      encontrados.push(ruta);
    }
  }
  return encontrados;
}

describe('referencias a documentacion', () => {
  it('todo docs/... que el codigo nombra existe de verdad', () => {
    const rotas: string[] = [];
    for (const carpeta of ['apps/api/src', 'apps/web/app', 'packages/shared/src']) {
      const absoluta = join(RAIZ, carpeta);
      if (!existsSync(absoluta)) continue;
      for (const archivo of archivosDeCodigo(absoluta)) {
        const texto = readFileSync(archivo, 'utf8');
        for (const [, referencia] of texto.matchAll(/(docs\/[A-Za-z0-9._/-]+\.md)/g)) {
          if (referencia && !existsSync(join(RAIZ, referencia))) {
            rotas.push(`${archivo.slice(RAIZ.length + 1)} -> ${referencia}`);
          }
        }
      }
    }

    // Si esto falla: o escribes el documento, o quitas la referencia. Dejar el
    // puntero a algo que no existe es peor que no ponerlo, porque promete que la
    // respuesta esta escrita en alguna parte.
    expect(rotas.sort()).toEqual([]);
  });
});
