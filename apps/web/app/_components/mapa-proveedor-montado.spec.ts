import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * El fondo del mapa: que ninguna pantalla lo monte sin proveedor.
 *
 * ── El defecto que este guardia existe para que no vuelva ─────────────────────
 *
 * `ProveedorOrigenTiles` se escribio justamente para arreglar el fondo apagado
 * en produccion... y no lo montaba NADIE. `MapaBase` cae entonces a
 * `ORIGEN_DE_COMPILACION`, que se resuelve al CARGAR EL MODULO leyendo
 * `process.env.NEXT_PUBLIC_MAP_TILES_URL` — una variable que Next reemplaza al
 * compilar y que `Dockerfile.web` no hornea. O sea: en produccion vale
 * 'sin-configurar' pase lo que pase.
 *
 * El sintoma no era una pantalla en blanco ni un error: era el mapa de recintos
 * dibujando los puntos sobre un fondo vacio y un aviso educado —"el fondo del
 * mapa no esta configurado, pidele al equipo tecnico que configure el proveedor
 * de mapas"— con MapTiler configurado y funcionando en Dokploy. El aviso mandaba
 * a arreglar lo unico que ya estaba bien.
 *
 * ── Por que se prueba leyendo el codigo ───────────────────────────────────────
 *
 * Jest del panel corre `*.spec.ts` en `node`, sin DOM: aca no se renderiza nada
 * (ver `jest.config.js`). Y aunque se renderizara, el fallo no esta DENTRO de un
 * componente sino en la ausencia de uno por encima — un render de `MapaRecintos`
 * suelto pasaria igual. Lo que hay que comprobar es el montaje, y el montaje
 * esta escrito en el arbol de archivos. Mismo criterio que
 * `privilegios.spec.ts`, que lee las migraciones.
 *
 * El guardia es de FAMILIA, no de este arreglo: descubre solo que componentes
 * dependen del contexto y que pantallas los montan. Un mapa nuevo en una
 * pantalla nueva queda cubierto sin tocar este archivo.
 */

const COMPONENTES = __dirname;
const APP = join(__dirname, '..');

function leer(ruta: string): string {
  return readFileSync(ruta, 'utf8');
}

/** Todos los `.tsx` de `app/`, sin bajar a las pruebas. */
function tsxDe(directorio: string): string[] {
  const encontrados: string[] = [];
  for (const entrada of readdirSync(directorio, { withFileTypes: true })) {
    const ruta = join(directorio, entrada.name);
    if (entrada.isDirectory()) {
      if (entrada.name !== 'node_modules') encontrados.push(...tsxDe(ruta));
    } else if (entrada.name.endsWith('.tsx') && !entrada.name.includes('.spec.')) {
      encontrados.push(ruta);
    }
  }
  return encontrados;
}

/**
 * ¿Este JSX pasa `origen=`?
 *
 * Se mira la etiqueta completa —desde `<MapaBase` hasta su `>`— y no la linea,
 * porque estas props van repartidas en varias lineas. Sin esto, un
 * `origen={...}` en la linea siguiente se leeria como ausente y el guardia
 * gritaria por una pantalla sana.
 */
function pasaOrigen(fuente: string, etiqueta: string): boolean {
  let desde = fuente.indexOf(`<${etiqueta}`);
  while (desde !== -1) {
    const hasta = fuente.indexOf('>', desde);
    const abertura = fuente.slice(desde, hasta === -1 ? undefined : hasta);
    if (!/\borigen=/.test(abertura)) return false;
    desde = fuente.indexOf(`<${etiqueta}`, desde + 1);
  }
  return true;
}

/**
 * Los componentes que resuelven el origen por CONTEXTO, descubiertos leyendo:
 * o llaman `useOrigenTiles()` derecho, o montan un `<MapaBase>` sin pasarle
 * `origen`. Los que reciben la prop del servidor no dependen del contexto y no
 * son asunto de este guardia.
 */
function dependenDelContexto(): string[] {
  const nombres: string[] = [];
  for (const ruta of tsxDe(COMPONENTES)) {
    const fuente = leer(ruta);
    const usaElGancho = /\buseOrigenTiles\s*\(/.test(fuente);
    const montaBaseSinOrigen = fuente.includes('<MapaBase') && !pasaOrigen(fuente, 'MapaBase');
    if (!usaElGancho && !montaBaseSinOrigen) continue;
    for (const nombre of fuente.matchAll(/export function ([A-Z]\w+)/g)) {
      nombres.push(nombre[1] as string);
    }
  }
  return [...new Set(nombres)].filter((n) => n !== 'ProveedorOrigenTiles');
}

describe('el proveedor del origen de tiles', () => {
  const porContexto = dependenDelContexto();

  it('hay al menos un componente que depende del contexto', () => {
    // Si esto queda vacio, el guardia de abajo pasa por no tener nada que
    // mirar. Un guardia que no puede fallar no es un guardia.
    expect(porContexto.length).toBeGreaterThan(0);
  });

  it('ninguna pantalla monta un mapa por contexto sin envolverlo', () => {
    const huerfanas: string[] = [];

    for (const ruta of tsxDe(APP)) {
      if (ruta.startsWith(COMPONENTES)) continue; // pantallas, no piezas
      const fuente = leer(ruta);
      const montados = porContexto.filter((nombre) => fuente.includes(`<${nombre}`));
      if (montados.length === 0) continue;
      if (fuente.includes('<ProveedorOrigenTiles')) continue;
      huerfanas.push(`${ruta.slice(APP.length + 1)} monta ${montados.join(', ')}`);
    }

    expect(huerfanas).toEqual([]);
  });

  it('el proveedor lee el entorno del SERVIDOR, no el horneado al compilar', () => {
    // `NEXT_PUBLIC_MAP_TILES_URL` se reemplaza al compilar y `Dockerfile.web` no
    // la hornea: montarlo con esa variable deja el fondo apagado igual, y con el
    // proveedor puesto, que es peor porque parece arreglado.
    //
    // Solo PANTALLAS: `mapa-origen-tiles.tsx` nombra las dos cosas en su
    // documentacion —el ejemplo de montaje y la variable que NO hay que usar— y
    // sin este recorte el guardia se acusaba a si mismo.
    for (const ruta of tsxDe(APP)) {
      if (ruta.startsWith(COMPONENTES)) continue;
      const fuente = leer(ruta);
      if (!fuente.includes('<ProveedorOrigenTiles')) continue;
      expect(fuente).toContain('entornoDeTilesDelServidor');
      expect(fuente).not.toContain('NEXT_PUBLIC_MAP_TILES_URL');
    }
  });
});
