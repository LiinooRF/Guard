'use client';

import { useMemo } from 'react';

import { MapaBase } from './mapa-base';
import { leyendaDeRuta, marcasDeRuta } from './guard-mapa-modelo';
import type { PuntoRuta, RegistroPunto } from './guard-shift-state';

/**
 * Visor de ruta del guardia (#76): el mapa de la ronda con el siguiente punto
 * destacado, los cumplidos en otro color y los pendientes.
 *
 * No trae mapa propio: reusa `MapaBase`, que ya resuelve los tiles, encuadra los
 * puntos y —clave para el terreno— **cae a una lista de lugares si Leaflet no
 * carga**. Ese es el "modo lista" de respaldo que pide el issue; la lista guiada
 * de la ronda sigue debajo igual.
 *
 * Si ningún punto tiene coordenadas, no se dibuja nada: la ronda se completa con
 * la lista, sin un mapa vacío que confunda.
 */
export function GuardMapa({
  puntos,
  registros,
  siguiente,
  siteName,
}: {
  puntos: readonly PuntoRuta[];
  registros: Record<string, RegistroPunto>;
  siguiente?: PuntoRuta;
  siteName: string;
}) {
  const escaneados = useMemo(() => new Set(Object.keys(registros)), [registros]);
  const siguienteId = siguiente?.id;

  const marcas = useMemo(
    () => marcasDeRuta(puntos, escaneados, siguienteId),
    [puntos, escaneados, siguienteId],
  );
  const leyenda = useMemo(
    () => leyendaDeRuta(puntos, escaneados, siguienteId),
    [puntos, escaneados, siguienteId],
  );

  if (marcas.length === 0) return null;

  return (
    <section className="guardia-mapa" aria-label="Mapa de la ronda">
      <MapaBase
        etiqueta={`Ruta de la ronda en ${siteName}`}
        puntos={marcas}
        leyenda={leyenda}
        alto="260px"
      />
    </section>
  );
}
