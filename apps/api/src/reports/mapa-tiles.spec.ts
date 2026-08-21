/**
 * La cartografía es un extra: si falla, el informe sale igual.
 *
 * Esa es la regla que estas pruebas protegen. El plano del recorrido se
 * generaba sin fondo y desde terreno el reporte fue "ni se ve el mapa"; sumarle
 * cartografía lo vuelve legible, pero el precio no puede ser que un informe
 * dependa de que un proveedor externo responda. Sin red, sin llave o con la
 * cuota agotada, el PDF tiene que seguir saliendo.
 */

import { elegirZoom, obtenerFondo } from './mapa-tiles';

/** Recinto de ~150 m, el caso normal. */
const RECINTO = { latMin: -33.3822, latMax: -33.3808, lonMin: -70.6932, lonMax: -70.6918 };
const CAJA = { ancho: 515, alto: 250 };
const URL = 'https://tiles.ejemplo/{z}/{x}/{y}.png';

describe('elegirZoom', () => {
  it('prefiere el mayor detalle que quepa en el tope de tiles', () => {
    const z = elegirZoom(RECINTO);
    expect(z).toBeGreaterThanOrEqual(16);
    expect(z).toBeLessThanOrEqual(19);
  });

  it('baja el detalle cuando el área es grande, en vez de pedir mil tiles', () => {
    const ciudad = { latMin: -33.65, latMax: -33.30, lonMin: -70.85, lonMax: -70.50 };
    expect(elegirZoom(ciudad)).toBeLessThan(elegirZoom(RECINTO));
  });

  it('con un tope más chico, elige menos zoom', () => {
    expect(elegirZoom(RECINTO, 4)).toBeLessThanOrEqual(elegirZoom(RECINTO, 24));
  });
});

describe('obtenerFondo', () => {
  const fetchOriginal = global.fetch;
  afterEach(() => {
    global.fetch = fetchOriginal;
  });

  it('sin proveedor configurado no intenta nada', async () => {
    const espia = jest.fn();
    global.fetch = espia as never;
    expect(await obtenerFondo(RECINTO, CAJA, undefined)).toBeNull();
    expect(espia).not.toHaveBeenCalled();
  });

  it('devuelve los tiles ubicados dentro de la caja del plano', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    }) as never;

    const fondo = await obtenerFondo(RECINTO, CAJA, URL);
    expect(fondo).not.toBeNull();
    expect(fondo!.tiles.length).toBeGreaterThan(0);
    for (const tile of fondo!.tiles) {
      expect(tile.tam).toBeGreaterThan(0);
      expect(Buffer.isBuffer(tile.datos)).toBe(true);
    }
    // El fondo tiene que cubrir el ancho del plano, o quedaría una franja blanca.
    const derecha = Math.max(...fondo!.tiles.map((t) => t.x + t.tam));
    expect(derecha).toBeGreaterThanOrEqual(CAJA.ancho - 1);
  });

  it('la atribución de OpenStreetMap viaja siempre: es obligación de licencia', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer,
    }) as never;
    const fondo = await obtenerFondo(RECINTO, CAJA, URL);
    expect(fondo!.atribucion).toContain('OpenStreetMap');
  });

  /*
   * Lo importante de todo el archivo: ninguna de estas situaciones puede
   * lanzar. Devolver null es lo que deja el informe salir sin cartografía.
   */
  it('si el proveedor responde error, devuelve null sin lanzar', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 }) as never;
    await expect(obtenerFondo(RECINTO, CAJA, URL)).resolves.toBeNull();
  });

  it('si la red falla, devuelve null sin lanzar', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ENOTFOUND')) as never;
    await expect(obtenerFondo(RECINTO, CAJA, URL)).resolves.toBeNull();
  });

  it('con un fondo a medias prefiere no dibujarlo: los huecos confunden más', async () => {
    // Fallan SIEMPRE los tiles de columna par, reintento incluido: si el corte
    // fuera pasajero el cliente se recupera solo, y eso ya está probado arriba.
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      const x = Number(String(url).split('/').at(-2));
      if (x % 2 === 0) throw new Error('corte permanente');
      return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
    }) as never;
    await expect(obtenerFondo(RECINTO, CAJA, URL)).resolves.toBeNull();
  });

  it('un corte pasajero no impide el fondo: reintenta', async () => {
    const fallados = new Set<string>();
    global.fetch = jest.fn().mockImplementation(async (url: string) => {
      if (!fallados.has(String(url))) {
        fallados.add(String(url));
        throw new Error('corte pasajero');
      }
      return { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
    }) as never;
    const fondo = await obtenerFondo(RECINTO, CAJA, URL);
    expect(fondo).not.toBeNull();
  });
});
