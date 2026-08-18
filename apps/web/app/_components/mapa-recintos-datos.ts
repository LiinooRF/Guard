/**
 * De lo que responde la API a lo que dibuja el mapa (#75).
 *
 * `mapa-base.tsx` no pide datos ni sabe de rondas: recibe puntos ya resueltos.
 * Este archivo es esa traduccion para la pantalla de recintos, y esta separado
 * del componente por lo mismo que `mapa-modelo.ts`: es logica pura, se prueba
 * con jest y no necesita navegador ni base de datos.
 *
 * Las formas de entrada estan leidas del `return filas.map(...)` de cada
 * servicio, no de un mock y no de esta cabecera: si algun dia no coinciden,
 * manda el servicio.
 *
 *   GET /api/admin/sites                        -> id, branchName, name, address,
 *                                                  latitude, longitude, isActive,
 *                                                  checkpointCount, supervisorCount
 *                                                  (admin.service.ts, listSites)
 *   GET /api/admin/sites/:siteId/checkpoints    -> id, siteId, name, description,
 *                                                  suggestedOrder, kind, latitude,
 *                                                  longitude, requiresPhoto,
 *                                                  instructions, isActive
 *                                                  (admin.service.ts, listCheckpoints)
 *   GET /api/supervisor/sites                   -> id, name, branchName, address,
 *                                                  timezone, latitude, longitude
 *                                                  (supervisor.service.ts,
 *                                                   listAssignedSites)
 *
 * Dos diferencias del tercero que importan y que hay que RE-VERIFICAR si ese
 * servicio cambia:
 *
 *   1. NO trae `isActive`, porque su SQL ya filtra `AND s.is_active`.
 *   2. SI trae `latitude`/`longitude`, y ya convertidos a numero
 *      (`Number(f.latitude)`), igual que el de administracion: el driver
 *      entrega `numeric` como texto.
 *
 * `timezone` llega y no se usa: el mapa no muestra horas.
 */

import type { GeoPoint } from '@sentrycore/shared';

import { esCoordenadaValida, type PuntoMapa } from './mapa-modelo';

/* ------------------------------------------------------------------ */
/* Lo que llega de la API                                              */
/* ------------------------------------------------------------------ */

export interface RecintoDelMapa {
  id: string;
  name: string;
  branchName: string;
  address?: string | null;
  /**
   * `numeric` de PostgreSQL. El servicio ya lo convierte a numero, pero se
   * acepta texto igual: si manana alguien devuelve la columna cruda, el mapa no
   * se apaga en silencio.
   */
  latitude?: number | string | null;
  longitude?: number | string | null;
  /**
   * Opcional porque las dos fuentes NO coinciden, y esta verificado en las dos:
   * `admin.service.ts` -> `listSites()` lo devuelve; `supervisor.service.ts` ->
   * `listAssignedSites()` no lo trae, porque ya filtra con `WHERE ... AND
   * s.is_active` en el SQL. Ausente = activo (ver `estaActivo`).
   */
  isActive?: boolean | null;
}

export interface PuntoDeControlDelMapa {
  id: string;
  name: string;
  /** 'normal' | 'acceso_critico' (checkpoints.kind). */
  kind?: string | null;
  suggestedOrder?: number | null;
  latitude?: number | string | null;
  longitude?: number | string | null;
  /**
   * OJO: son TRES estados, no un si/no.
   *   true  -> este punto pide foto siempre
   *   false -> este punto no pide foto aunque las reglas la exijan
   *   null  -> no sobreescribe nada: manda la regla (fuera de horario, o punto
   *            critico). Ver isPhotoRequired() en packages/shared/src/domain.ts.
   * Leerlo como interruptor encendido/apagado es exactamente el error que ya
   * cometimos con gpsSharingMandatory.
   */
  requiresPhoto?: boolean | null;
  /** `checkpoints.is_active` es `NOT NULL` y `listCheckpoints()` siempre lo manda. */
  isActive?: boolean | null;
}

export interface ResumenDeUbicaciones {
  /** Recintos que se muestran (los dados de baja no cuentan). */
  activos: number;
  conUbicacion: number;
  sinUbicacion: number;
}

/* ------------------------------------------------------------------ */
/* Coordenadas                                                         */
/* ------------------------------------------------------------------ */

/**
 * `null`, `undefined` y texto vacio NO son cero.
 *
 * `Number(null)` es 0 y `Number('')` tambien. Un recinto con latitud sin cargar
 * y longitud cargada pasaria como (0, -70.6) —una coordenada perfectamente
 * valida en medio del Atlantico— y el recinto apareceria a 4.000 km de donde
 * esta. `esCoordenadaValida` no lo atrapa: solo descarta el (0,0) exacto.
 */
export function aNumero(valor: number | string | null | undefined): number | null {
  if (valor === null || valor === undefined) return null;
  if (typeof valor === 'string' && valor.trim().length === 0) return null;
  const numero = Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

/** La coordenada de una fila, o `null` si no tiene una utilizable. */
export function coordenadaDe(fila: {
  latitude?: number | string | null;
  longitude?: number | string | null;
}): GeoPoint | null {
  const lat = aNumero(fila.latitude);
  const lng = aNumero(fila.longitude);
  if (lat === null || lng === null) return null;
  if (!esCoordenadaValida(lat, lng)) return null;
  return { lat, lng };
}

/**
 * Un solo lugar decide que esta dado de baja.
 *
 * Sin el campo se asume activo, y eso NO es una suposicion comoda: es lo que
 * hace `GET /api/supervisor/sites`, que filtra los inactivos en el `WHERE` y no
 * manda `isActive`. Lo usan el mapa y el selector de la pantalla, para que "que
 * se ve en el mapa" y "que se ve en la lista" no se separen nunca.
 */
export function estaActivo(fila: { isActive?: boolean | null }): boolean {
  return fila.isActive !== false;
}

/* ------------------------------------------------------------------ */
/* Textos de los globos                                                */
/* ------------------------------------------------------------------ */

/** Segunda linea del globo de un recinto: sucursal y direccion. */
export function detalleDelRecinto(recinto: RecintoDelMapa): string {
  const direccion = (recinto.address ?? '').trim();
  const sucursal = recinto.branchName.trim();
  return [sucursal, direccion].filter((parte) => parte.length > 0).join(' · ');
}

/**
 * Segunda linea del globo de un punto de control.
 *
 * Los tres estados de `requiresPhoto` se dicen distinto a proposito. Decirle
 * "sin foto" a un punto que en realidad hereda la regla —y que fuera de horario
 * SI va a exigir foto— es mentirle al jefe de operaciones sobre lo que le va a
 * pasar al guardia a las 3 de la manana.
 */
export function detalleDelPunto(punto: PuntoDeControlDelMapa): string {
  const clase = punto.kind === 'acceso_critico' ? 'Acceso crítico' : 'Punto normal';

  if (punto.requiresPhoto === true) return `${clase} · Pide foto siempre`;
  if (punto.requiresPhoto === false) return `${clase} · Sin foto, aunque las reglas la pidan`;
  return `${clase} · La foto la deciden las reglas`;
}

/* ------------------------------------------------------------------ */
/* Marcas del mapa                                                     */
/* ------------------------------------------------------------------ */

/** Los recintos activos que tienen ubicacion cargada, como marcas del mapa. */
export function marcasDeRecintos(
  recintos: ReadonlyArray<RecintoDelMapa>,
): PuntoMapa[] {
  const marcas: PuntoMapa[] = [];
  for (const recinto of recintos) {
    if (!estaActivo(recinto)) continue;
    const coordenada = coordenadaDe(recinto);
    if (!coordenada) continue;
    marcas.push({
      id: recinto.id,
      lat: coordenada.lat,
      lng: coordenada.lng,
      titulo: recinto.name,
      detalle: detalleDelRecinto(recinto),
      variante: 'recinto',
    });
  }
  return marcas;
}

/**
 * Los puntos de control activos con ubicacion, como marcas.
 *
 * El acceso critico va en rojo ('alerta') porque es lo que el jefe de
 * operaciones busca en el mapa. El numero de la marca es el ORDEN SUGERIDO del
 * punto, que no es el orden de la ronda: la ruta define su propia secuencia y
 * puede ademas venir aleatorizada por `randomizeRouteOrder`. Cuando el orden
 * sugerido es 0 —el default de la tabla— la marca va sin numero en vez de
 * mostrar un cero que no significa nada.
 */
export function marcasDePuntosDeControl(
  puntos: ReadonlyArray<PuntoDeControlDelMapa>,
): PuntoMapa[] {
  const marcas: PuntoMapa[] = [];
  for (const punto of puntos) {
    if (!estaActivo(punto)) continue;
    const coordenada = coordenadaDe(punto);
    if (!coordenada) continue;

    const orden = aNumero(punto.suggestedOrder ?? null);
    const marca: PuntoMapa = {
      id: punto.id,
      lat: coordenada.lat,
      lng: coordenada.lng,
      titulo: punto.name,
      detalle: detalleDelPunto(punto),
      variante: punto.kind === 'acceso_critico' ? 'alerta' : 'punto',
    };
    if (orden !== null && orden > 0) marca.numero = Math.trunc(orden);
    marcas.push(marca);
  }
  return marcas;
}

/**
 * Que se dibuja segun haya o no un recinto elegido.
 *
 * Sin eleccion: todos los recintos, para ver la operacion completa de un vistazo.
 * Con eleccion: ese recinto y sus puntos de control, que es el detalle.
 */
export function armarMarcas(args: {
  recintos: ReadonlyArray<RecintoDelMapa>;
  elegidoId: string | null;
  puntosDeControl: ReadonlyArray<PuntoDeControlDelMapa>;
}): PuntoMapa[] {
  const { recintos, elegidoId, puntosDeControl } = args;
  if (elegidoId === null) return marcasDeRecintos(recintos);

  const elegido = recintos.find((recinto) => recinto.id === elegidoId);
  const marcaDelRecinto = elegido ? marcasDeRecintos([elegido]) : [];
  return [...marcaDelRecinto, ...marcasDePuntosDeControl(puntosDeControl)];
}

/* ------------------------------------------------------------------ */
/* Eleccion de recinto y encuadre                                      */
/* ------------------------------------------------------------------ */

/**
 * Que recinto quedo elegido.
 *
 * Solo devuelve el pedido si viene en la lista que el servidor entrego para
 * ESTA sesion. Un id en la barra de direcciones no prueba nada, y esto importa
 * mas todavia el dia que la lista venga recortada (los recintos asignados de un
 * SUPERVISOR): el recorte no puede saltarse escribiendo otro id en la URL. No
 * es control de acceso —eso lo hace el servidor, que responde 403— pero evita
 * pedirle algo que ya se sabe que va a negar.
 */
export function recintoElegido(
  recintos: ReadonlyArray<RecintoDelMapa>,
  pedido: string | null | undefined,
): string | null {
  if (typeof pedido !== 'string' || pedido.trim().length === 0) return null;
  const existe = recintos.some(
    (recinto) => recinto.id === pedido && estaActivo(recinto),
  );
  return existe ? pedido : null;
}

/** Centro de respaldo: sirve cuando el recinto elegido no tiene nada que encuadrar. */
export function centroDelRecinto(
  recintos: ReadonlyArray<RecintoDelMapa>,
  elegidoId: string | null,
): GeoPoint | null {
  if (elegidoId === null) return null;
  const elegido = recintos.find((recinto) => recinto.id === elegidoId);
  return elegido ? coordenadaDe(elegido) : null;
}

/** Cuantos recintos hay y cuantos tienen ubicacion, para explicar un mapa vacio. */
export function resumenDeUbicaciones(
  recintos: ReadonlyArray<RecintoDelMapa>,
): ResumenDeUbicaciones {
  let activos = 0;
  let conUbicacion = 0;
  for (const recinto of recintos) {
    if (!estaActivo(recinto)) continue;
    activos += 1;
    if (coordenadaDe(recinto)) conUbicacion += 1;
  }
  return { activos, conUbicacion, sinUbicacion: activos - conUbicacion };
}

/* ------------------------------------------------------------------ */
/* Reglas                                                              */
/* ------------------------------------------------------------------ */

/**
 * Zoom de arranque, desde la configuracion de la empresa.
 *
 * `mapDefaultZoom` TODAVIA NO EXISTE en `packages/shared/src/rules.ts`: el zod y
 * la ficha de catalogo exactos van propuestos en INTEGRACION.md y los aplica
 * quien integre (rules.ts esta fuera de esta entrega). Mientras no exista, esto
 * devuelve `undefined` y `MapaBase` cae en su constante; el dia que exista, la
 * pantalla lo respeta sin tocar una linea.
 *
 * Se valida el rango aca ademas de en el zod porque el valor llega por HTTP: un
 * zoom 40 deja el mapa en gris y nadie entiende por que.
 */
export function zoomDeLasReglas(reglas: unknown): number | undefined {
  if (typeof reglas !== 'object' || reglas === null) return undefined;
  const valor = (reglas as { mapDefaultZoom?: unknown }).mapDefaultZoom;
  if (typeof valor !== 'number' || !Number.isInteger(valor)) return undefined;
  if (valor < 1 || valor > 22) return undefined;
  return valor;
}
