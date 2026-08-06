'use client';

import { useEffect, useMemo } from 'react';

import { MapaBase } from './mapa-base';
import { leyendaDeRuta, marcasDeRuta } from './guard-mapa-modelo';
import { precacheTilesDeRuta } from './guard-tiles-offline';
import { useOrigenTiles } from './mapa-origen-tiles';
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
 *
 * El origen de los tiles sale del contexto que deja `ProveedorOrigenTiles` en la
 * pagina (#75). `MapaBase` lo toma solo; aca se lee ademas porque la precarga
 * offline necesita la MISMA plantilla, y si cada uno la resolviera por su cuenta
 * el guardia terminaria con un cache de tiles de otro proveedor.
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
  const origen = useOrigenTiles();

  const marcas = useMemo(
    () => marcasDeRuta(puntos, escaneados, siguienteId),
    [puntos, escaneados, siguienteId],
  );
  const leyenda = useMemo(
    () => leyendaDeRuta(puntos, escaneados, siguienteId),
    [puntos, escaneados, siguienteId],
  );

  // Con señal, baja los tiles del recinto para que el mapa siga estando en modo
  // avión (#76). Best-effort: si no se puede, el mapa online y el modo lista
  // siguen.
  //
  // Este efecto vuelve a correr en CADA escaneo, porque `marcas` cambia de color.
  // Las coordenadas no cambian, asi que `precacheTilesDeRuta` reconoce el lote y
  // no vuelve a pedir nada: sin esa memoria eran ~240 tiles por escaneo.
  useEffect(() => {
    if (marcas.length === 0) return;
    void precacheTilesDeRuta(origen.url, marcas);
  }, [marcas, origen.url]);

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
