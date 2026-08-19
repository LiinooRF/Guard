'use client';

import { useEffect, useRef, useState } from 'react';
import type { CircleMarker, Map as LeafletMap, Polyline } from 'leaflet';
import { formatearAtribucionTileLayer, resolverOrigenTiles } from './mapa-tiles';
import { COLOR_SECUNDARIO_MARCA } from './mapa-colores';
import { esCoordenadaValida } from './mapa-modelo';

interface MapPoint {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
}

export function RouteMap({
  points,
  siteCenter,
  tileUrl,
  attribution,
}: {
  points: MapPoint[];
  siteCenter: [number, number] | null;
  tileUrl: string | null;
  attribution: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const layers = useRef<Array<CircleMarker | Polyline>>([]);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  const ubicados = points.filter(
    (point): point is MapPoint & { latitude: number; longitude: number } =>
      esCoordenadaValida(point.latitude, point.longitude),
  );
  const sinUbicacion = points.length - ubicados.length;

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    if (!element.current || !tileUrl || map.current) return;
    let alive = true;

    void import('leaflet').then((leaflet) => {
      if (!alive || !element.current) return;
      const initialCenter: [number, number] =
        siteCenter && esCoordenadaValida(siteCenter[0], siteCenter[1])
          ? siteCenter
          : [-33.4489, -70.6693];

      const instance = leaflet.map(element.current, {
        center: initialCenter,
        zoom: siteCenter ? 17 : 11,
        scrollWheelZoom: false,
        preferCanvas: true,
      });

      // El origen pasa por resolverOrigenTiles(): impide que un MAP_TILE_URL
      // apuntando a tile.openstreetmap.org sirva tiles publicos en produccion.
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
          .on('tileerror', () => setFailed(true))
          .addTo(instance);
      }
      map.current = instance;
      setReady(true);
    });

    return () => {
      alive = false;
      map.current?.remove();
      map.current = null;
      setReady(false);
    };
  }, [attribution, siteCenter, tileUrl]);

  useEffect(() => {
    const instance = map.current;
    if (!instance || !ready) return;

    void import('leaflet').then((leaflet) => {
      layers.current.forEach((layer) => layer.remove());
      layers.current = [];

      const located = points.filter(
        (point): point is MapPoint & { latitude: number; longitude: number } =>
          esCoordenadaValida(point.latitude, point.longitude),
      );
      const coordinates = located.map(
        (point) => [point.latitude, point.longitude] as [number, number],
      );

      if (coordinates.length > 1) {
        layers.current.push(
          leaflet
            .polyline(coordinates, {
              color: COLOR_SECUNDARIO_MARCA,
              weight: 4,
              opacity: 0.85,
              lineJoin: 'round',
              lineCap: 'round',
              dashArray: '6 7',
            })
            .addTo(instance),
        );
      }

      located.forEach((point) => {
        const order = points.findIndex((candidate) => candidate.id === point.id) + 1;
        const marker = leaflet
          .circleMarker([point.latitude, point.longitude], {
            radius: 11,
            color: '#ffffff',
            weight: 3,
            fillColor: '#111b32',
            fillOpacity: 1,
          })
          .bindTooltip(`${order}. ${point.name}`, { permanent: true, direction: 'top' })
          .addTo(instance);
        layers.current.push(marker);
      });

      if (coordinates.length) {
        instance.fitBounds(leaflet.latLngBounds(coordinates).pad(0.18), { maxZoom: 18 });
      }
    });
  }, [points, ready]);

  if (!tileUrl) {
    return (
      <div className="map-unavailable">
        Configura <code>MAP_TILE_URL</code> para ver el recorrido. El orden sigue siendo editable.
      </div>
    );
  }

  return (
    <div className="coordinate-map-shell route-map-shell">
      <div className="route-map" ref={element} aria-label="Vista previa del recorrido" />
      {sinUbicacion > 0 ? (
        <p className="section-explanation" style={{ margin: '.4rem 0 0', fontSize: '.72rem' }}>
          {sinUbicacion === 1
            ? '1 punto sin coordenada GPS (interior/subterráneo); se conserva en el orden de la ruta.'
            : `${sinUbicacion} puntos sin coordenada GPS (interiores/subterráneos); se conservan en el orden de la ruta.`}
        </p>
      ) : null}
      {failed ? (
        <p className="map-error">El proveedor cartográfico no respondió; la secuencia se conserva.</p>
      ) : null}
    </div>
  );
}
