/**
 * Cartografía de fondo para el plano del informe.
 *
 * POR QUE EXISTE
 * ---------------------------------------------------------------------------
 * El plano del recorrido se dibujaba sobre papel en blanco: lineas y circulos a
 * escala, sin una calle. Tecnicamente correcto y practicamente inservible —
 * desde terreno el reporte fue literal, "ni se ve el mapa". Un supervisor no
 * puede ubicar un recorrido sin referencias.
 *
 * POR QUE NO SE COMPONE UNA IMAGEN
 * ---------------------------------------------------------------------------
 * Lo natural seria pegar los tiles en un lienzo y meter una sola imagen en el
 * PDF, pero eso exige `sharp` o `canvas`: dependencias binarias que hay que
 * compilar en la imagen de Docker y mantener. PDFKit ya sabe recortar y colocar
 * imagenes, asi que cada tile se dibuja en su posicion dentro de un `clip`. Sin
 * dependencias nuevas y con el mismo resultado.
 *
 * QUE PASA SI FALLA
 * ---------------------------------------------------------------------------
 * El informe NO puede depender de que un tercero responda. Si los tiles no
 * llegan —sin red, sin llave, proveedor caido, cuota agotada— se devuelve null
 * y el plano sale como antes, a escala y sin fondo. Un informe sin cartografia
 * es peor que uno con ella, pero infinitamente mejor que ninguno.
 */
import { setTimeout as esperar } from 'node:timers/promises';

const TAM_TILE = 256;
/** Tope duro de tiles por informe: acota latencia y consumo de cuota. */
const MAX_TILES = 24;
const TIMEOUT_MS = 6_000;
/**
 * Zoom maximo al que se piden tiles. Configurable porque depende del proveedor:
 * MapTiler sirve calles hasta z22, otros cortan antes y devuelven 404. Si se
 * pide mas de lo que hay, el informe sale sin fondo — por eso es una variable y
 * no un numero fijo aca dentro.
 */
const ZOOM_MAX = Number(process.env.MAP_TILES_MAX_ZOOM) || 19;
const ZOOM_MIN = 12;

export interface TileDibujable {
  /** Imagen PNG cruda, lista para `doc.image`. */
  readonly datos: Buffer;
  /** Posicion y tamaño DENTRO de la caja del plano, en puntos PDF. */
  readonly x: number;
  readonly y: number;
  readonly tam: number;
}

export interface FondoCartografico {
  readonly tiles: readonly TileDibujable[];
  /** Texto de atribucion. Obligatorio por la licencia ODbL de OpenStreetMap. */
  readonly atribucion: string;
}

export interface RecuadroGeografico {
  readonly latMin: number;
  readonly latMax: number;
  readonly lonMin: number;
  readonly lonMax: number;
}

function aTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

function aTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180;
  return ((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2) * 2 ** z;
}

/**
 * El zoom mas alto que cubra el recuadro sin pasarse del tope de tiles.
 *
 * Se busca de mas detalle a menos y no al reves: en un recinto de 150 metros la
 * diferencia entre zoom 18 y 16 es ver los galpones o ver una mancha gris.
 */
export function elegirZoom(recuadro: RecuadroGeografico, maxTiles = MAX_TILES): number {
  for (let z = ZOOM_MAX; z >= ZOOM_MIN; z -= 1) {
    const x0 = Math.floor(aTileX(recuadro.lonMin, z));
    const x1 = Math.floor(aTileX(recuadro.lonMax, z));
    const y0 = Math.floor(aTileY(recuadro.latMax, z));
    const y1 = Math.floor(aTileY(recuadro.latMin, z));
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= maxTiles) return z;
  }
  return ZOOM_MIN;
}

async function bajarTile(url: string): Promise<Buffer | null> {
  for (let intento = 0; intento < 2; intento += 1) {
    const corte = AbortSignal.timeout(TIMEOUT_MS);
    try {
      const respuesta = await fetch(url, {
        signal: corte,
        headers: { 'User-Agent': 'SentryCore-Informe/1.0' },
      });
      if (!respuesta.ok) return null;
      return Buffer.from(await respuesta.arrayBuffer());
    } catch {
      if (intento === 0) await esperar(250);
    }
  }
  return null;
}

/**
 * Baja los tiles que cubren el recuadro y los deja ubicados dentro de la caja.
 *
 * `plantillaUrl` usa los marcadores {z}/{x}/{y} — el mismo formato que ya
 * consume el panel web, para no tener dos configuraciones que se contradigan.
 */
export async function obtenerFondo(
  recuadro: RecuadroGeografico,
  caja: { ancho: number; alto: number },
  plantillaUrl: string | undefined,
): Promise<FondoCartografico | null> {
  if (!plantillaUrl) return null;

  const z = elegirZoom(recuadro);
  const xIni = Math.floor(aTileX(recuadro.lonMin, z));
  const xFin = Math.floor(aTileX(recuadro.lonMax, z));
  const yIni = Math.floor(aTileY(recuadro.latMax, z));
  const yFin = Math.floor(aTileY(recuadro.latMin, z));

  // Cuantos puntos PDF mide un tile: se escala el mundo de tiles al ancho real
  // de la caja del plano, para que fondo y marcas queden alineados.
  const anchoEnTiles = aTileX(recuadro.lonMax, z) - aTileX(recuadro.lonMin, z);
  const tamTile = caja.ancho / anchoEnTiles;
  const offsetX = (aTileX(recuadro.lonMin, z) - xIni) * tamTile;
  const offsetY = (aTileY(recuadro.latMax, z) - yIni) * tamTile;

  const pedidos: Promise<TileDibujable | null>[] = [];
  for (let xt = xIni; xt <= xFin; xt += 1) {
    for (let yt = yIni; yt <= yFin; yt += 1) {
      const url = plantillaUrl
        .replace('{z}', String(z))
        .replace('{x}', String(xt))
        .replace('{y}', String(yt));
      const x = (xt - xIni) * tamTile - offsetX;
      const y = (yt - yIni) * tamTile - offsetY;
      pedidos.push(bajarTile(url).then((datos) => (datos ? { datos, x, y, tam: tamTile } : null)));
    }
  }

  const resueltos = (await Promise.all(pedidos)).filter((t): t is TileDibujable => t !== null);
  // Un fondo a medias —con huecos blancos— confunde mas que no tenerlo.
  if (resueltos.length === 0 || resueltos.length < pedidos.length * 0.7) return null;

  return {
    tiles: resueltos,
    atribucion: plantillaUrl.includes('maptiler')
      ? '© MapTiler © OpenStreetMap contributors'
      : '© OpenStreetMap contributors',
  };
}

export const SOLO_PARA_PRUEBAS = { TAM_TILE, MAX_TILES, aTileX, aTileY };
