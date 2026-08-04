'use client';

import { useEffect, useRef, useState } from 'react';
import type { CircleMarker, Map as LeafletMap } from 'leaflet';
import { resolverOrigenTiles } from './mapa-tiles';

const SANTIAGO: [number, number] = [-33.4489, -70.6693];

export function CoordinateMap({
  latitude,
  longitude,
  tileUrl,
  attribution,
  onPick,
}: {
  latitude: number | null;
  longitude: number | null;
  tileUrl: string | null;
  attribution: string;
  onPick?: (latitude: number, longitude: number) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const marker = useRef<CircleMarker | null>(null);
  const callback = useRef(onPick);
  const [error, setError] = useState(false);
  callback.current = onPick;

  useEffect(() => {
    if (!element.current || !tileUrl || map.current) return;
    let alive = true;
    void import('leaflet').then((leaflet) => {
      if (!alive || !element.current) return;
      const initial: [number, number] = latitude !== null && longitude !== null
        ? [latitude, longitude]
        : SANTIAGO;
      const instance = leaflet.map(element.current, {
        center: initial,
        zoom: latitude === null ? 11 : 18,
        zoomControl: true,
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
            attribution: origen.atribucionProveedor ?? attribution,
            maxZoom: origen.maxZoom,
          })
          .on('tileerror', () => setError(true))
          .addTo(instance);
      }
      if (latitude !== null && longitude !== null) {
        marker.current = leaflet.circleMarker([latitude, longitude], {
          radius: 8,
          color: '#ffffff',
          weight: 3,
          fillColor: '#4263eb',
          fillOpacity: 1,
        }).addTo(instance);
      }
      instance.on('click', (event: { latlng: { lat: number; lng: number } }) => {
        callback.current?.(event.latlng.lat, event.latlng.lng);
      });
      map.current = instance;
    });
    return () => {
      alive = false;
      map.current?.remove();
      map.current = null;
      marker.current = null;
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
        fillColor: '#4263eb',
        fillOpacity: 1,
      }).addTo(instance);
      instance.setView([latitude, longitude], Math.max(instance.getZoom(), 17));
    });
  }, [latitude, longitude]);

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
