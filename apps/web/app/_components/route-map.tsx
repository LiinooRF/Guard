'use client';

import { useEffect, useRef, useState } from 'react';
import type { CircleMarker, Map as LeafletMap, Polyline } from 'leaflet';
import { resolverOrigenTiles } from './mapa-tiles';

interface MapPoint { id: string; name: string; latitude: number | null; longitude: number | null }

export function RouteMap({ points, siteCenter, tileUrl, attribution }: {
  points: MapPoint[]; siteCenter: [number, number] | null;
  tileUrl: string | null; attribution: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const layers = useRef<Array<CircleMarker | Polyline>>([]);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!element.current || !tileUrl || map.current) return;
    let alive = true;
    void import('leaflet').then((leaflet) => {
      if (!alive || !element.current) return;
      const instance = leaflet.map(element.current, {
        center: siteCenter ?? [-33.4489, -70.6693], zoom: siteCenter ? 17 : 11,
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
          .on('tileerror', () => setFailed(true))
          .addTo(instance);
      }
      map.current = instance;
      setReady(true);
    });
    return () => { alive = false; map.current?.remove(); map.current = null; setReady(false); };
  }, [attribution, siteCenter, tileUrl]);

  useEffect(() => {
    const instance = map.current;
    if (!instance) return;
    void import('leaflet').then((leaflet) => {
      layers.current.forEach((layer) => layer.remove());
      const located = points.filter((point): point is MapPoint & { latitude: number; longitude: number } =>
        point.latitude !== null && point.longitude !== null);
      const coordinates = located.map((point) => [point.latitude, point.longitude] as [number, number]);
      if (coordinates.length > 1) layers.current.push(
        leaflet.polyline(coordinates, { color: '#4263eb', weight: 4, opacity: .85 }).addTo(instance),
      );
      located.forEach((point) => {
        const order = points.findIndex((candidate) => candidate.id === point.id) + 1;
        const marker = leaflet.circleMarker([point.latitude, point.longitude], {
          radius: 11, color: '#fff', weight: 3, fillColor: '#111b32', fillOpacity: 1,
        }).bindTooltip(`${order}. ${point.name}`, { permanent: true, direction: 'top' }).addTo(instance);
        layers.current.push(marker);
      });
      if (coordinates.length) instance.fitBounds(leaflet.latLngBounds(coordinates).pad(.18), { maxZoom: 18 });
    });
  }, [points, ready]);

  if (!tileUrl) return <div className="map-unavailable">Configura <code>MAP_TILE_URL</code> para ver el recorrido. El orden sigue siendo editable.</div>;
  return <div className="coordinate-map-shell route-map-shell">
    <div className="route-map" ref={element} aria-label="Vista previa del recorrido" />
    {failed ? <p className="map-error">El proveedor cartográfico no respondió; la secuencia se conserva.</p> : null}
  </div>;
}
