/**
 * Paleta y nombres de las capas del mapa (#75).
 *
 * Estaba adentro de `mapa-base.tsx` como constantes privadas. Se saca aca por
 * una razon concreta: la leyenda tiene que pintar EXACTAMENTE el mismo color que
 * la marca. Con dos copias de la paleta, el dia que alguien ajusta el azul del
 * mapa la leyenda queda mintiendo, y una leyenda que miente es peor que no
 * tenerla —el jefe de operaciones lee "acceso critico" en un color que en el
 * mapa significa otra cosa—.
 *
 * Sin React y sin Leaflet a proposito: lo importa tanto el componente cliente
 * del mapa como la leyenda, que se renderiza en el servidor.
 *
 * Los valores son espejo de las variables de `globals.css`; el bloque de CSS que
 * hay que agregar alla esta en INTEGRACION.md.
 */

import type { VarianteMarca, VarianteTraza } from './mapa-modelo';

/** Acento del tenant; el fallback conserva la apariencia sin marca configurada. */
export const COLOR_SECUNDARIO_MARCA = 'var(--marca-secundario, #4263eb)';

/** Que se dibuja: una marca (circulo) o una traza (linea). */
export type ClaveLeyenda = VarianteMarca | VarianteTraza;

export const COLOR_MARCA: Record<VarianteMarca, string> = {
  punto: COLOR_SECUNDARIO_MARCA,
  recinto: '#111b32',
  inicio: '#18a66a',
  fin: '#8a55d7',
  alerta: '#df5360',
};

export const COLOR_TRAZA: Record<VarianteTraza, string> = {
  recorrido: COLOR_SECUNDARIO_MARCA,
  ruta: '#687086',
};

/**
 * Nombre por defecto de cada variante, en lenguaje del panel.
 *
 * Es un DEFAULT, no una verdad: la misma variante significa cosas distintas
 * segun la pantalla ('alerta' es "con novedad" en el monitoreo en vivo y
 * "acceso critico" en el catalogo de recintos). Por eso cada pantalla puede
 * pasar su propio texto en el item de la leyenda.
 */
export const ETIQUETA_LEYENDA: Record<ClaveLeyenda, string> = {
  punto: 'Punto de control',
  recinto: 'Recinto',
  inicio: 'Inicio de la ronda',
  fin: 'Punto de cierre',
  alerta: 'Requiere atención',
  recorrido: 'Recorrido del guardia',
  ruta: 'Ruta planificada',
};

const CLAVES_DE_TRAZA: ReadonlyArray<ClaveLeyenda> = ['recorrido', 'ruta'];

/** Las claves de marca y de traza no se pisan, asi que basta con mirar la lista. */
export function esClaveDeTraza(clave: ClaveLeyenda): clave is VarianteTraza {
  return CLAVES_DE_TRAZA.includes(clave);
}

export function colorDeLeyenda(clave: ClaveLeyenda): string {
  return esClaveDeTraza(clave) ? COLOR_TRAZA[clave] : COLOR_MARCA[clave];
}
