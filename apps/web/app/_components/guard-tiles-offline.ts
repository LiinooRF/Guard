'use client';

/**
 * Precarga de tiles para uso offline (#76).
 *
 * Cuando la ronda carga con señal, se calculan los tiles del recinto y se le
 * piden al Service Worker (`/sw-tiles.js`) que los guarde. Así, en modo avión,
 * el mapa se dibuja desde el cache en vez de quedar en blanco.
 *
 * Todo es best-effort y degrada en silencio: sin Service Worker, sin proveedor
 * de tiles o sin señal, no se precachea nada y el mapa sigue funcionando online
 * y el modo lista queda de respaldo. Nunca rompe la ronda.
 *
 * ── Dos cosas que cambiaron con #75 ───────────────────────────────────────────
 *
 * 1. **La plantilla llega por parametro.** Antes se resolvia aca leyendo
 *    `process.env.NEXT_PUBLIC_MAP_TILES_URL`, que en la imagen de produccion vale
 *    `undefined` —solo se hornea `NEXT_PUBLIC_API_URL`, ver `Dockerfile.web`—, asi
 *    que la funcion salia por el `return` temprano y NO se precacheaba nada. El
 *    origen ahora lo resuelve el servidor y baja por contexto
 *    (`mapa-origen-tiles.tsx`).
 *
 * 2. **No se repite lo ya pedido.** Quien llama es un efecto que depende de las
 *    marcas de la ruta, y esas se recalculan en CADA escaneo (cambia el color del
 *    punto cumplido, no su coordenada). Sin memoria, una ronda de doce puntos
 *    pedia doce veces los mismos ~240 tiles: 2.880 peticiones al proveedor por
 *    ronda y por guardia, que es la forma mas rapida de gastarse la cuota y que
 *    nos bloqueen — justo lo que el criterio de aceptacion de #75 pide evitar.
 *    Las coordenadas de la ruta no cambian durante la ronda, asi que el segundo
 *    llamado no tiene nada nuevo que bajar.
 */

import { recuadroDePuntos, tilesDelRecuadro, urlDeTile } from './guard-tiles-modelo';

/** Niveles que se bajan: suficientes para ubicarse dentro de un recinto. */
const ZOOMS_OFFLINE = [15, 16, 17];

export interface PuntoConCoordenada {
  lat: number;
  lng: number;
}

/**
 * Que tiles cubren la ruta. Pura y sin red, para poder probar que el conjunto NO
 * depende del avance de la ronda.
 *
 * Devuelve `[]` cuando no hay plantilla o no hay puntos: los dos casos son
 * normales (empresa sin proveedor configurado, ruta sin coordenadas cargadas).
 */
export function urlsDeTilesDeRuta(
  plantilla: string | null,
  puntos: ReadonlyArray<PuntoConCoordenada>,
): string[] {
  if (!plantilla) return [];
  const recuadro = recuadroDePuntos(puntos);
  if (!recuadro) return [];
  return tilesDelRecuadro(recuadro, ZOOMS_OFFLINE).map((tile) => urlDeTile(plantilla, tile));
}

/**
 * Identifica un lote de precarga para no repetirlo.
 *
 * `tilesDelRecuadro` es determinista —mismo recuadro, misma lista y en el mismo
 * orden—, asi que el largo y los extremos alcanzan para reconocerlo sin recorrer
 * cientos de strings en cada escaneo. Dos lotes distintos podrian dar la misma
 * firma en teoria; el costo seria saltarse una precarga, y esto ya es
 * best-effort: el mapa online y el modo lista siguen funcionando igual.
 */
export function firmaDePrecache(urls: readonly string[]): string {
  if (urls.length === 0) return '';
  return `${urls.length}|${urls[0]}|${urls[urls.length - 1]}`;
}

/**
 * Lotes ya pedidos en esta carga de pagina.
 *
 * A nivel de modulo y no de componente a proposito: el guardia entra y sale de la
 * vista de ronda durante el turno, y un estado por componente se perderia en cada
 * montaje, que es justo cuando se volveria a disparar la descarga.
 */
const yaPedidos = new Set<string>();

/** Solo para las pruebas: la memoria de modulo sobrevive entre casos. */
export function olvidarPrecachesPedidos(): void {
  yaPedidos.clear();
}

export async function precacheTilesDeRuta(
  plantilla: string | null,
  puntos: ReadonlyArray<PuntoConCoordenada>,
): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (navigator.onLine === false) return; // Sin señal no hay nada que bajar.

  const urls = urlsDeTilesDeRuta(plantilla, puntos);
  if (urls.length === 0) return;

  const firma = firmaDePrecache(urls);
  if (yaPedidos.has(firma)) return;
  // Se marca ANTES de esperar al Service Worker: dos escaneos seguidos disparan
  // el efecto dos veces y ambos llegarian aca antes de que el primero terminara.
  yaPedidos.add(firma);

  try {
    await navigator.serviceWorker.register('/sw-tiles.js');
    const registro = await navigator.serviceWorker.ready;
    registro.active?.postMessage({ type: 'precache-tiles', urls });
  } catch {
    // Sin SW no hay tiles offline; el mapa online y el modo lista siguen.
    // Se olvida el lote para que un proximo montaje lo pueda reintentar: el fallo
    // suele ser transitorio (el SW todavia no activo), no una configuracion mala.
    yaPedidos.delete(firma);
  }
}
