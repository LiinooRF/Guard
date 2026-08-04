/**
 * Atribucion y avisos del mapa (#75).
 *
 * Va aparte del mapa a proposito, y no como el control de atribucion de Leaflet:
 *
 * 1. La atribucion a OpenStreetMap es OBLIGATORIA por licencia. Si dependiera
 *    del control de Leaflet, un mapa que no alcanzo a cargar —o que se cayo por
 *    falta de senal— quedaria sin ella. Asi se renderiza en el servidor y esta
 *    ahi antes de que llegue una sola imagen.
 * 2. El control de Leaflet mete su propio "Leaflet" con enlace y un estilo que
 *    no es el del panel. Esto se ve como el resto de la interfaz.
 *
 * Sin `'use client'`: son componentes de presentacion puros. No pagan bundle.
 */

import { ATRIBUCION_OSM, ENLACE_LICENCIA_OSM, type OrigenTiles } from './mapa-tiles';

/** Espejo de las variables de `globals.css`; ver INTEGRACION.md. */
const COLOR_TENUE = '#687086';
const COLOR_AVISO_TEXTO = '#916217';
const COLOR_AVISO_BORDE = '#efd7ae';
const COLOR_AVISO_FONDO = '#fff9ed';

export function MapaAtribucion({ origen }: { origen: OrigenTiles }) {
  return (
    <p
      className="mapa-atribucion"
      style={{
        margin: '.5rem 0 0',
        color: COLOR_TENUE,
        fontSize: '.65rem',
        lineHeight: 1.5,
      }}
    >
      Mapa{' '}
      <a
        href={ENLACE_LICENCIA_OSM}
        target="_blank"
        rel="noreferrer noopener"
        style={{ textDecoration: 'underline' }}
      >
        © {ATRIBUCION_OSM}
      </a>
      {origen.atribucionProveedor ? <span> · {origen.atribucionProveedor}</span> : null}
    </p>
  );
}

/**
 * El aviso cuando el fondo del mapa no esta como corresponde.
 *
 * Esta escrito para el jefe de operaciones —dice que se ve y a quien pedirle
 * que lo arregle—, no para el que configura el servidor. El detalle tecnico
 * viaja en `origen.motivo` y no se muestra.
 */
export function MapaAviso({ aviso }: { aviso: string | null }) {
  if (!aviso) return null;
  return (
    <p
      className="mapa-aviso"
      role="status"
      style={{
        margin: '0 0 .6rem',
        border: `1px solid ${COLOR_AVISO_BORDE}`,
        borderRadius: '.65rem',
        padding: '.6rem .75rem',
        color: COLOR_AVISO_TEXTO,
        background: COLOR_AVISO_FONDO,
        fontSize: '.72rem',
        lineHeight: 1.5,
      }}
    >
      {aviso}
    </p>
  );
}
