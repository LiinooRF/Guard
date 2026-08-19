'use client';

import { useEffect, useRef, useState } from 'react';
import type { CircleMarker, LayerGroup, Map as LeafletMap } from 'leaflet';
import { formatearAtribucionTileLayer, resolverOrigenTiles } from './mapa-tiles';
import { COLOR_MARCA, COLOR_SECUNDARIO_MARCA } from './mapa-colores';
import { esCoordenadaValida } from './mapa-modelo';

const SANTIAGO: [number, number] = [-33.4489, -70.6693];

/**
 * Un punto que YA existe y hay que dibujar, distinto del que se esta marcando
 * en el formulario.
 *
 * Existe porque el mapa solo sabia pintar la coordenada del formulario: al
 * guardar, el formulario se limpia y el pin se iba con el, asi que el punto
 * recien creado desaparecia de la vista aunque estuviera guardado y con
 * coordenadas validas. Quien crea puntos necesita ver los que ya puso —si no,
 * no tiene forma de saber donde va el siguiente ni si el anterior quedo.
 */
export interface MarcaExistente {
  id: string;
  latitude: number;
  longitude: number;
  label: string;
  /** 'alerta' pinta los accesos criticos, igual que la leyenda del catalogo. */
  variante?: 'punto' | 'alerta';
}

export function CoordinateMap({
  latitude,
  longitude,
  tileUrl,
  attribution,
  onPick,
  markers,
}: {
  latitude: number | null;
  longitude: number | null;
  tileUrl: string | null;
  attribution: string;
  onPick?: (latitude: number, longitude: number) => void;
  markers?: MarcaExistente[];
}) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const marker = useRef<CircleMarker | null>(null);
  const capa = useRef<LayerGroup | null>(null);
  const encuadrado = useRef(false);
  const callback = useRef(onPick);
  const [error, setError] = useState(false);
  // El mapa se arma con un import() dinamico: los efectos que dibujan encima
  // tienen que esperarlo o corren una vez, con map.current todavia en null, y
  // no vuelven a intentarlo nunca.
  const [listo, setListo] = useState(false);
  callback.current = onPick;

  const existentes = markers ?? [];
  const claveMarcas = existentes
    .map((punto) => `${punto.id}:${punto.latitude}:${punto.longitude}:${punto.variante ?? 'punto'}`)
    .join('|');

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (!element.current || !tileUrl || map.current) return;
    let alive = true;
    void import('leaflet').then((leaflet) => {
      if (!alive || !element.current) return;
      const initial: [number, number] =
        latitude !== null && longitude !== null && esCoordenadaValida(latitude, longitude)
          ? [latitude, longitude]
          : SANTIAGO;
      const instance = leaflet.map(element.current, {
        center: initial,
        zoom: latitude === null ? 11 : 18,
        zoomControl: true,
        scrollWheelZoom: false,
        preferCanvas: true,
      });
      // El origen pasa por resolverOrigenTiles(): impide que un MAP_TILE_URL
      // apuntando a tile.openstreetmap.org sirva tiles publicos en produccion,
      // cosa que su politica de uso prohibe. Sin origen valido el mapa va SIN
      // fondo y las capas propias se siguen viendo.
      const origen = resolverOrigenTiles({
        url: tileUrl || undefined,
        atribucion: attribution || undefined,
        produccion: process.env.NODE_ENV === 'production',
      });
      if (origen.url) {
        leaflet
          .tileLayer(origen.url, {
            attribution: formatearAtribucionTileLayer(origen.atribucionProveedor ?? attribution),
            maxZoom: origen.maxZoom,
            updateWhenIdle: true,
            keepBuffer: 1,
          })
          .on('tileerror', () => setError(true))
          .addTo(instance);
      }
      capa.current = leaflet.layerGroup().addTo(instance);
      if (latitude !== null && longitude !== null && esCoordenadaValida(latitude, longitude)) {
        marker.current = leaflet.circleMarker([latitude, longitude], {
          radius: 8,
          color: '#ffffff',
          weight: 3,
          fillColor: COLOR_SECUNDARIO_MARCA,
          fillOpacity: 1,
        }).addTo(instance);
      }
      instance.on('click', (event: { latlng: { lat: number; lng: number } }) => {
        if (esCoordenadaValida(event.latlng.lat, event.latlng.lng)) {
          callback.current?.(event.latlng.lat, event.latlng.lng);
        }
      });
      map.current = instance;
      setListo(true);
    });
    return () => {
      alive = false;
      map.current?.remove();
      map.current = null;
      marker.current = null;
      capa.current = null;
      encuadrado.current = false;
      setListo(false);
    };
    // Las coordenadas se sincronizan en el efecto siguiente; no se reconstruye
    // Leaflet en cada click.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attribution, tileUrl]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || latitude === null || longitude === null) return;
    void import('leaflet').then((leaflet) => {
      marker.current?.remove();
      marker.current = leaflet.circleMarker([latitude, longitude], {
        radius: 8,
        color: '#ffffff',
        weight: 3,
        fillColor: COLOR_SECUNDARIO_MARCA,
        fillOpacity: 1,
      }).addTo(instance);
      instance.setView([latitude, longitude], Math.max(instance.getZoom(), 17));
    });
  }, [latitude, longitude, listo]);

  useEffect(() => {
    const instance = map.current;
    const grupo = capa.current;
    if (!instance || !grupo) return;
    void import('leaflet').then((leaflet) => {
      grupo.clearLayers();
      for (const punto of existentes) {
        leaflet
          .circleMarker([punto.latitude, punto.longitude], {
            radius: 7,
            color: '#ffffff',
            weight: 2,
            fillColor: COLOR_MARCA[punto.variante ?? 'punto'],
            fillOpacity: 0.95,
          })
          .bindTooltip(punto.label, { direction: 'top' })
          .addTo(grupo);
      }
      // Encuadrar una sola vez y solo si el formulario no manda: mover la vista
      // mientras alguien esta marcando un punto le mueve el mapa bajo el dedo.
      if (!encuadrado.current && existentes.length && latitude === null && longitude === null) {
        encuadrado.current = true;
        const limites = leaflet.latLngBounds(
          existentes.map((punto) => [punto.latitude, punto.longitude] as [number, number]),
        );
        instance.fitBounds(limites, { padding: [40, 40], maxZoom: 18 });
      }
    });
    // `claveMarcas` resume la lista: el array llega nuevo en cada render del
    // padre y usarlo de dependencia redibujaria para siempre.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claveMarcas, listo]);

  if (!tileUrl) {
    return (
      <div className="map-unavailable" role="status">
        Configura <code>MAP_TILE_URL</code> para habilitar el mapa. Las coordenadas se pueden
        ingresar manualmente mientras tanto.
      </div>
    );
  }

  return (
    <div className="coordinate-map-shell">
      <div className="coordinate-map" ref={element} aria-label="Mapa para seleccionar ubicación" />
      {error ? <p className="map-error">El proveedor de mapa no respondió. Conservamos las coordenadas ingresadas.</p> : null}
    </div>
  );
}
