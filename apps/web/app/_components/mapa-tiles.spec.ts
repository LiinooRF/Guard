/**
 * Pruebas del origen de tiles (#75).
 *
 * Lo que se prueba es la regla que nos puede costar el servicio: que los tiles
 * publicos de OpenStreetMap NO salgan a produccion por descuido, y que una
 * configuracion rota degrade a "mapa sin fondo" en vez de dejar el panel en
 * blanco.
 */

import { MAX_ZOOM_POR_DEFECTO, TILES_PUBLICOS_OSM, resolverOrigenTiles } from './mapa-tiles';

const PROVEEDOR = 'https://tiles.midominio.cl/rondas/{z}/{x}/{y}.png';

describe('resolverOrigenTiles', () => {
  it('usa el proveedor configurado y no muestra ningun aviso', () => {
    const origen = resolverOrigenTiles({ url: PROVEEDOR, produccion: true });

    expect(origen.estado).toBe('configurado');
    expect(origen.url).toBe(PROVEEDOR);
    expect(origen.aviso).toBeNull();
    expect(origen.maxZoom).toBe(MAX_ZOOM_POR_DEFECTO);
  });

  it('en produccion sin proveedor deja el mapa sin fondo, no cae a los tiles publicos', () => {
    const origen = resolverOrigenTiles({ produccion: true });

    expect(origen.estado).toBe('sin-configurar');
    expect(origen.url).toBeNull();
    expect(origen.aviso).not.toBeNull();
  });

  it('en desarrollo sin proveedor usa los tiles publicos y avisa', () => {
    const origen = resolverOrigenTiles({ produccion: false });

    expect(origen.estado).toBe('desarrollo');
    expect(origen.url).toBe(TILES_PUBLICOS_OSM);
    expect(origen.aviso).not.toBeNull();
  });

  it('rechaza los tiles publicos de OSM configurados a mano en produccion', () => {
    const origen = resolverOrigenTiles({
      url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      produccion: true,
    });

    expect(origen.estado).toBe('invalido');
    expect(origen.url).toBeNull();
  });

  it('tambien rechaza los subdominios de los tiles publicos de OSM', () => {
    for (const plantilla of [
      'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
      'https://b.TILE.OpenStreetMap.org/{z}/{x}/{y}.png',
      'https://tile.osm.org/{z}/{x}/{y}.png',
    ]) {
      const origen = resolverOrigenTiles({ url: plantilla, produccion: true });
      expect(origen.estado).toBe('invalido');
      expect(origen.url).toBeNull();
    }
  });

  it('acepta los tiles publicos de OSM fuera de produccion', () => {
    const origen = resolverOrigenTiles({
      url: 'https://a.tile.openstreetmap.org/{z}/{x}/{y}.png',
      produccion: false,
    });

    expect(origen.estado).toBe('desarrollo');
    expect(origen.url).not.toBeNull();
  });

  it('rechaza una plantilla sin las marcas z, x, y', () => {
    const origen = resolverOrigenTiles({
      url: 'https://tiles.midominio.cl/rondas.png',
      produccion: true,
    });

    expect(origen.estado).toBe('invalido');
    expect(origen.url).toBeNull();
    expect(origen.motivo).toContain('{z}');
  });

  it('rechaza http en produccion, porque el navegador lo bloquea en una pagina https', () => {
    const origen = resolverOrigenTiles({
      url: 'http://tiles.midominio.cl/{z}/{x}/{y}.png',
      produccion: true,
    });

    expect(origen.estado).toBe('invalido');
  });

  it('acepta http fuera de produccion, para un servidor de tiles local', () => {
    const origen = resolverOrigenTiles({
      url: 'http://localhost:8080/{z}/{x}/{y}.png',
      produccion: false,
    });

    expect(origen.estado).toBe('configurado');
    expect(origen.url).toBe('http://localhost:8080/{z}/{x}/{y}.png');
  });

  it('rechaza algo que no es una URL', () => {
    const origen = resolverOrigenTiles({ url: '{z}/{x}/{y}.png', produccion: true });

    expect(origen.estado).toBe('invalido');
    expect(origen.url).toBeNull();
  });

  it('lee el zoom maximo del entorno y descarta los valores fuera de rango', () => {
    expect(resolverOrigenTiles({ url: PROVEEDOR, maxZoom: '17', produccion: true }).maxZoom).toBe(17);
    expect(resolverOrigenTiles({ url: PROVEEDOR, maxZoom: '99', produccion: true }).maxZoom).toBe(
      MAX_ZOOM_POR_DEFECTO,
    );
    expect(resolverOrigenTiles({ url: PROVEEDOR, maxZoom: 'harto', produccion: true }).maxZoom).toBe(
      MAX_ZOOM_POR_DEFECTO,
    );
  });

  it('arrastra la atribucion del proveedor y trata el texto vacio como ausente', () => {
    expect(
      resolverOrigenTiles({ url: PROVEEDOR, atribucion: '© Proveedor', produccion: true })
        .atribucionProveedor,
    ).toBe('© Proveedor');
    expect(
      resolverOrigenTiles({ url: PROVEEDOR, atribucion: '   ', produccion: true })
        .atribucionProveedor,
    ).toBeNull();
  });
});
