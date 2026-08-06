'use client';

/**
 * El origen de tiles, resuelto en el SERVIDOR y bajado por contexto (#75).
 *
 * ── Que problema resuelve ─────────────────────────────────────────────────────
 *
 * `MapaBase` necesita saber de donde bajar las imagenes del mapa. Hasta ahora lo
 * sacaba de `process.env.NEXT_PUBLIC_MAP_TILES_URL`, y eso no puede funcionar en
 * el VPS: Next reemplaza `NEXT_PUBLIC_*` cuando corre `next build`, o sea DENTRO
 * de la construccion de la imagen, y `Dockerfile.web` solo hornea
 * `NEXT_PUBLIC_API_URL`. La variable que el despliegue si entrega —`MAP_TILE_URL`,
 * en el `environment:` de los dos compose— llega al contenedor en tiempo de
 * ejecucion, donde el bundle del navegador ya no la puede leer.
 *
 * Resultado: el fondo del mapa quedaba apagado en produccion pasara lo que
 * pasara. Con esto, un componente de servidor resuelve el origen en cada request
 * y lo deja disponible para todo `MapaBase` que cuelgue debajo.
 *
 * ── Por que contexto y no una prop ────────────────────────────────────────────
 *
 * Por el carril del guardia. Ahi el mapa vive en
 * `page.tsx -> GuardShift -> GuardMapa -> MapaBase`, y pasar la prop a mano
 * obligaria a tocar cuatro componentes que son de otro issue solo para acarrear
 * un dato de configuracion. El contexto lo entrega una vez arriba.
 *
 * La prop `origen` de `MapaBase` sigue existiendo y GANA sobre el contexto: es la
 * que usa `RecorridoPatrulla`, que ya recibe `tileUrl` del servidor por su cuenta,
 * y es tambien la puerta para un proveedor por empresa el dia que se quiera.
 *
 * ── Que viaja al navegador ────────────────────────────────────────────────────
 *
 * Un `OrigenTiles`: la plantilla, el zoom maximo, la atribucion y el aviso. Nada
 * de datos de personas ni coordenadas. Pero SI viaja la plantilla completa, asi
 * que si el proveedor elegido pide llave, esa llave queda a la vista de
 * cualquiera que abra el inspector. Por eso la decision
 * (`docs/decisions/0002-proveedor-de-tiles-del-mapa.md`) solo admite proveedores
 * con llave restringida por dominio, o servir los tiles por una ruta nuestra
 * (`/tiles/{z}/{x}/{y}.png`) con la llave puesta en el proxy.
 */

import { createContext, useContext, type ReactNode } from 'react';

import { resolverOrigenTiles, type OrigenTiles } from './mapa-tiles';

/**
 * Ultimo recurso, solo para `npm run dev`.
 *
 * Se resuelve una sola vez, al cargar el modulo. `process.env.NEXT_PUBLIC_*` se
 * reemplaza al COMPILAR y solo si se escribe literal: nada de armar el nombre de
 * la variable, porque queda `undefined` en el navegador y el mapa se apaga sin
 * explicacion.
 *
 * En produccion esto siempre da 'sin-configurar' —la variable no se hornea en la
 * imagen— y eso esta bien: significa que la pantalla no quedo envuelta por
 * `ProveedorOrigenTiles`, y el aviso a la vista lo dice en vez de disimularlo.
 */
export const ORIGEN_DE_COMPILACION: OrigenTiles = resolverOrigenTiles({
  url: process.env.NEXT_PUBLIC_MAP_TILES_URL,
  atribucion: process.env.NEXT_PUBLIC_MAP_TILES_ATTRIBUTION,
  maxZoom: process.env.NEXT_PUBLIC_MAP_TILES_MAX_ZOOM,
  produccion: process.env.NODE_ENV === 'production',
});

const ContextoOrigenTiles = createContext<OrigenTiles | null>(null);

/**
 * Envuelve la pantalla y deja el origen disponible para todo `MapaBase` de abajo.
 *
 * Lo monta un componente de SERVIDOR, que es quien puede leer `MAP_TILE_URL` en
 * cada request:
 *
 *   <ProveedorOrigenTiles origen={resolverOrigenTiles(entornoDeTilesDelServidor(process.env))}>
 */
export function ProveedorOrigenTiles({
  origen,
  children,
}: {
  origen: OrigenTiles;
  children: ReactNode;
}) {
  return <ContextoOrigenTiles.Provider value={origen}>{children}</ContextoOrigenTiles.Provider>;
}

/**
 * El origen vigente. Sin proveedor arriba cae al de compilacion, que en
 * desarrollo trae los tiles publicos de OSM y en produccion apaga el fondo.
 */
export function useOrigenTiles(): OrigenTiles {
  return useContext(ContextoOrigenTiles) ?? ORIGEN_DE_COMPILACION;
}
