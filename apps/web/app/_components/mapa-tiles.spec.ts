/**
 * Pruebas del origen de tiles (#75).
 *
 * Lo que se prueba es la regla que nos puede costar el servicio: que los tiles
 * publicos de OpenStreetMap NO salgan a produccion por descuido, y que una
 * configuracion rota degrade a "mapa sin fondo" en vez de dejar el panel en
 * blanco.
 *
 * Y, desde que el origen se resuelve en el servidor, que se lea la variable que
 * el despliegue de VERDAD entrega (`MAP_TILE_URL`) y no la que se hornea al
 * compilar.
 */

import {
  MAX_ZOOM_POR_DEFECTO,
  TILES_PUBLICOS_OSM,
  entornoDeTilesDelServidor,
  formatearAtribucionTileLayer,
  resolverOrigenTiles,
} from './mapa-tiles';

const PROVEEDOR = 'https://tiles.midominio.cl/rondas/{z}/{x}/{y}.png';

describe('formatearAtribucionTileLayer', () => {
  it('devuelve atribución OpenStreetMap con enlace cuando no hay proveedor extra', () => {
    const atrib = formatearAtribucionTileLayer(null);
    expect(atrib).toContain('https://www.openstreetmap.org/copyright');
    expect(atrib).toContain('colaboradores de OpenStreetMap');
  });

  it('concatena atribución del proveedor con la de OpenStreetMap', () => {
    const atrib = formatearAtribucionTileLayer('© MapTiler');
    expect(atrib).toContain('colaboradores de OpenStreetMap');
    expect(atrib).toContain('© MapTiler');
  });

  it('no duplica si la cadena ya contiene OpenStreetMap', () => {
    const atrib = formatearAtribucionTileLayer('© OpenStreetMap contributors');
    expect(atrib).toBe('© OpenStreetMap contributors');
  });
});

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

/*
 * Ruta del mismo origen.
 *
 * Es la forma que toma la opcion del proxy inverso, que es la unica manera de
 * que la llave del proveedor no viaje al navegador. Antes caia en "no es una URL
 * valida" —`new URL('/tiles/...')` lanza— y el mapa quedaba sin fondo con la
 * configuracion correcta puesta.
 */
describe('resolverOrigenTiles con una ruta del mismo origen', () => {
  it('acepta /tiles/{z}/{x}/{y}.png en produccion, sin aviso', () => {
    const origen = resolverOrigenTiles({ url: '/tiles/{z}/{x}/{y}.png', produccion: true });

    expect(origen.estado).toBe('configurado');
    expect(origen.url).toBe('/tiles/{z}/{x}/{y}.png');
    expect(origen.aviso).toBeNull();
  });

  it('no la confunde con http y no la exige https', () => {
    // La sirve nuestro propio origen: si la pagina es https, el tile tambien.
    const origen = resolverOrigenTiles({ url: '/mapa/{z}/{x}/{y}.webp', produccion: true });

    expect(origen.estado).toBe('configurado');
  });

  it('sigue exigiendo las marcas z, x, y', () => {
    const origen = resolverOrigenTiles({ url: '/tiles/todo.png', produccion: true });

    expect(origen.estado).toBe('invalido');
  });

  it('rechaza la URL con protocolo heredado, que apunta a OTRO dominio', () => {
    // `//otro.cl/...` parece una ruta nuestra y no lo es: el navegador la pide
    // con el protocolo de la pagina al host de al lado. Si se aceptara, un valor
    // mal pegado en Dokploy mandaria a los clientes a un tercero.
    for (const plantilla of [
      '//tiles.otro.cl/{z}/{x}/{y}.png',
      '//tile.openstreetmap.org/{z}/{x}/{y}.png',
      '/\\tiles.otro.cl/{z}/{x}/{y}.png',
    ]) {
      const origen = resolverOrigenTiles({ url: plantilla, produccion: true });
      expect(origen.estado).toBe('invalido');
      expect(origen.url).toBeNull();
    }
  });
});

/*
 * La lectura del entorno del servidor.
 *
 * Esta es la prueba que faltaba y que dejo el fondo del mapa apagado en el VPS:
 * el componente leia `NEXT_PUBLIC_MAP_TILES_URL` y el despliegue entrega
 * `MAP_TILE_URL`. Los nombres se comparan contra `.env.example` y contra el
 * `environment:` de docker-compose.dokploy.yml, no contra lo que creia el que
 * escribio el componente.
 */
describe('entornoDeTilesDelServidor', () => {
  it('lee MAP_TILE_URL, MAP_ATTRIBUTION y MAP_TILES_MAX_ZOOM', () => {
    const entorno = entornoDeTilesDelServidor({
      MAP_TILE_URL: PROVEEDOR,
      MAP_ATTRIBUTION: '© Proveedor',
      MAP_TILES_MAX_ZOOM: '18',
      NODE_ENV: 'production',
    });

    expect(entorno).toEqual({
      url: PROVEEDOR,
      atribucion: '© Proveedor',
      maxZoom: '18',
      produccion: true,
    });
  });

  it('solo NODE_ENV=production cuenta como produccion', () => {
    expect(entornoDeTilesDelServidor({ NODE_ENV: 'production' }).produccion).toBe(true);
    expect(entornoDeTilesDelServidor({ NODE_ENV: 'development' }).produccion).toBe(false);
    expect(entornoDeTilesDelServidor({ NODE_ENV: 'test' }).produccion).toBe(false);
    expect(entornoDeTilesDelServidor({}).produccion).toBe(false);
  });

  it('el entorno del VPS bien configurado enciende el fondo del mapa', () => {
    const origen = resolverOrigenTiles(
      entornoDeTilesDelServidor({
        MAP_TILE_URL: '/tiles/{z}/{x}/{y}.png',
        MAP_ATTRIBUTION: '© Proveedor',
        NODE_ENV: 'production',
      }),
    );

    expect(origen.estado).toBe('configurado');
    expect(origen.url).toBe('/tiles/{z}/{x}/{y}.png');
    expect(origen.atribucionProveedor).toBe('© Proveedor');
  });

  it('el contenedor sin MAP_TILE_URL apaga el fondo y lo dice, sin caer a OSM publico', () => {
    const origen = resolverOrigenTiles(entornoDeTilesDelServidor({ NODE_ENV: 'production' }));

    expect(origen.estado).toBe('sin-configurar');
    expect(origen.url).toBeNull();
    expect(origen.aviso).not.toBeNull();
  });

  it('el default de MAP_ATTRIBUTION de los compose no rompe la resolucion', () => {
    // docker-compose.dokploy.yml trae `(c) OpenStreetMap contributors` como
    // default de MAP_ATTRIBUTION, y ese texto llega aunque no haya proveedor.
    const origen = resolverOrigenTiles(
      entornoDeTilesDelServidor({
        MAP_ATTRIBUTION: '(c) OpenStreetMap contributors',
        NODE_ENV: 'production',
      }),
    );

    expect(origen.estado).toBe('sin-configurar');
    expect(origen.atribucionProveedor).toBe('(c) OpenStreetMap contributors');
  });
});
