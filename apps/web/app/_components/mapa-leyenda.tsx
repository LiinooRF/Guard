/**
 * Leyenda del mapa (#75).
 *
 * El mapa distingue cosas por COLOR —el recinto en azul oscuro, el punto de
 * control en azul, el acceso critico en rojo— y un color sin leyenda no comunica
 * nada: el jefe de operaciones ve puntos de dos colores y tiene que adivinar. Es
 * el mismo criterio de la tabla que acompana a cada grafica.
 *
 * Va aparte del lienzo y NO se dibuja con Leaflet: asi sigue estando cuando la
 * libreria no llego (subterraneo, WebView sin senal) y la lista de lugares es lo
 * unico que queda. Eso es lo que gana este archivo, y es lo unico.
 *
 * No lleva `'use client'`, pero NO por bundle: hoy su unico consumidor es
 * `mapa-base.tsx`, que si lo lleva, asi que esto y `mapa-colores.ts` viajan igual
 * al navegador. Sin la directiva puede ademas renderizarse desde un componente
 * de servidor el dia que se le pase como `children` a `MapaBase`; mientras eso
 * no pase, no descuenta un solo byte.
 */

import {
  ETIQUETA_LEYENDA,
  colorDeLeyenda,
  esClaveDeTraza,
  type ClaveLeyenda,
} from './mapa-colores';

export interface ItemLeyenda {
  clave: ClaveLeyenda;
  /**
   * Texto de esta pantalla. Sin el, se usa el nombre por defecto de la variante.
   * Existe porque la misma variante significa cosas distintas segun la pantalla
   * (ver ETIQUETA_LEYENDA en mapa-colores.ts).
   */
  texto?: string;
}

const COLOR_TENUE = '#4d566b';

export function MapaLeyenda({ items }: { items: ReadonlyArray<ItemLeyenda> }) {
  if (items.length === 0) return null;

  return (
    <ul
      className="mapa-leyenda"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '.45rem .95rem',
        margin: '.6rem 0 0',
        padding: 0,
        listStyle: 'none',
        color: COLOR_TENUE,
        fontSize: '.7rem',
        lineHeight: 1.5,
      }}
    >
      {items.map((item) => (
        <li
          key={item.clave}
          style={{ display: 'inline-flex', alignItems: 'center', gap: '.4rem' }}
        >
          <Muestra clave={item.clave} />
          {item.texto ?? ETIQUETA_LEYENDA[item.clave]}
        </li>
      ))}
    </ul>
  );
}

/**
 * El cuadradito de color.
 *
 * `aria-hidden` porque no aporta nada a quien usa lector de pantalla: el texto
 * de al lado ya dice que es. La linea de la ruta va punteada igual que en el
 * mapa, para que se distinga del recorrido sin depender del color.
 */
function Muestra({ clave }: { clave: ClaveLeyenda }) {
  const color = colorDeLeyenda(clave);

  if (esClaveDeTraza(clave)) {
    return (
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: '1.35rem',
          height: 0,
          borderTop: `3px ${clave === 'ruta' ? 'dashed' : 'solid'} ${color}`,
        }}
      />
    );
  }

  return (
    <span
      aria-hidden="true"
      style={{
        display: 'inline-block',
        width: '.75rem',
        height: '.75rem',
        borderRadius: '50%',
        border: '2px solid #ffffff',
        boxShadow: '0 1px 3px rgba(24,38,72,.35)',
        background: color,
      }}
    />
  );
}
