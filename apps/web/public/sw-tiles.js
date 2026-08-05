/*
 * Service Worker acotado a los tiles del mapa (#76).
 *
 * Único objetivo: que el guardia siga viendo el mapa de su recinto en modo
 * avión. NO cachea nada de la app —ni HTML, ni scripts, ni datos—: solo
 * responde peticiones de imagen que ya estan en el cache de tiles, y deja pasar
 * todo lo demas a la red sin tocarlo. Asi no cambia el comportamiento del resto
 * del portal ni se mete con otras pantallas.
 *
 * El precache lo dispara el cliente con un mensaje `precache-tiles` cuando la
 * ronda carga con señal; aca solo se bajan y se guardan.
 */

const CACHE_TILES = 'voxia-tiles-v1';

// Plantilla de ruta de tile: .../{z}/{x}/{y}.ext — para decidir si una imagen
// que no estaba en cache vale la pena guardarla al pasar por la red.
const RUTA_DE_TILE = /\/\d+\/\d+\/\d+(\.\w+)?(\?|$)/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (evento) => evento.waitUntil(self.clients.claim()));

self.addEventListener('message', (evento) => {
  const dato = evento.data;
  if (!dato || dato.type !== 'precache-tiles' || !Array.isArray(dato.urls)) return;
  evento.waitUntil(precachear(dato.urls));
});

async function precachear(urls) {
  const cache = await caches.open(CACHE_TILES);
  await Promise.all(
    urls.map(async (url) => {
      try {
        // `no-cors`: los tiles son de otro origen; la respuesta opaca igual
        // sirve para pintar la imagen y se puede guardar en el cache.
        const respuesta = await fetch(url, { mode: 'no-cors', cache: 'no-store' });
        await cache.put(url, respuesta);
      } catch {
        // Sin señal para un tile puntual: no aborta el resto del precache.
      }
    }),
  );
}

self.addEventListener('fetch', (evento) => {
  const peticion = evento.request;
  // Solo imagenes GET. Todo lo demas (navegacion, scripts, API) pasa intacto.
  if (peticion.method !== 'GET' || peticion.destination !== 'image') return;

  evento.respondWith(
    caches.open(CACHE_TILES).then((cache) =>
      cache.match(peticion).then((enCache) => {
        if (enCache) return enCache;
        return fetch(peticion)
          .then((respuesta) => {
            if (RUTA_DE_TILE.test(peticion.url) && (respuesta.ok || respuesta.type === 'opaque')) {
              cache.put(peticion, respuesta.clone());
            }
            return respuesta;
          })
          .catch(() => enCache);
      }),
    ),
  );
});
