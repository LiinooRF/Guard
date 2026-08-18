/**
 * Los puntos ya guardados que el mapa de gestion dibuja.
 *
 * Existe porque `CoordinateMap` solo sabia pintar la coordenada del formulario:
 * al guardar, el formulario se limpia y el pin se iba con el, asi que el punto
 * recien creado desaparecia del mapa aunque estuviera guardado y con
 * coordenadas validas. El sintoma que reporto el supervisor —"el pin rojo
 * aparece al marcarlo y despues de guardar no aparece mas"— es exactamente eso,
 * y se veia igual creando por formulario que importando por CSV, porque el
 * defecto nunca estuvo en la creacion sino en el dibujo.
 *
 * Modulo aparte y sin React: lo usan la pantalla del SUPERVISOR y la del ADMIN,
 * y asi las dos arman la marca igual. Una copia por pantalla es como se llega a
 * que el mismo punto se vea distinto segun quien lo mire.
 */

import type { MarcaExistente } from './coordinate-map';

/** Lo minimo que necesita el mapa; ambas pantallas tienen estos campos. */
export interface PuntoDibujable {
  id: string;
  name: string;
  suggestedOrder: number;
  kind: 'normal' | 'acceso_critico';
  latitude: number | null;
  longitude: number | null;
}

/**
 * Los puntos SIN coordenadas quedan fuera a proposito.
 *
 * El listado ya los muestra como «Sin ubicación» y el aviso de la pantalla los
 * cuenta. Inventarles una posicion —la del recinto, por ejemplo— seria peor que
 * no dibujarlos: el antifraude compara la posicion del escaneo contra la del
 * punto, y marcaria como anomalo todo lo que pase ahi.
 */
export function marcasDePuntos(puntos: PuntoDibujable[]): MarcaExistente[] {
  return puntos
    .filter((punto) => punto.latitude !== null && punto.longitude !== null)
    .map((punto) => ({
      id: punto.id,
      latitude: punto.latitude as number,
      longitude: punto.longitude as number,
      label: `${punto.suggestedOrder}. ${punto.name}`,
      variante: punto.kind === 'acceso_critico' ? ('alerta' as const) : ('punto' as const),
    }));
}
