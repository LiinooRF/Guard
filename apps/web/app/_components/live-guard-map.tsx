'use client';

import { useEffect, useRef } from 'react';
import type { LayerGroup, Map as LeafletMap } from 'leaflet';

export interface LivePosition {
  patrolId: string;
  guardName: string;
  siteName: string;
  latitude: number;
  longitude: number;
  recordedAt: string;
  accuracyM: number | null;
}

export function LiveGuardMap({
  positions,
  tileUrl,
  attribution,
}: {
  positions: LivePosition[];
  tileUrl: string;
  attribution: string;
}) {
  const element = useRef<HTMLDivElement>(null);
  const map = useRef<LeafletMap | null>(null);
  const markers = useRef<LayerGroup | null>(null);
  const leaflet = useRef<typeof import('leaflet') | null>(null);
  const latestPositions = useRef(positions);
  latestPositions.current = positions;

  useEffect(() => {
    let disposed = false;
    void import('leaflet').then((L) => {
      if (disposed || !element.current) return;
      leaflet.current = L;
      const instance = L.map(element.current, { zoomControl: true });
      map.current = instance;
      L.tileLayer(tileUrl, { attribution, maxZoom: 20 }).addTo(instance);
      markers.current = L.layerGroup().addTo(instance);
      renderPositions(L, instance, markers.current, latestPositions.current);
    });
    return () => {
      disposed = true;
      map.current?.remove();
      map.current = null;
      markers.current = null;
      leaflet.current = null;
    };
  }, [attribution, tileUrl]);

  useEffect(() => {
    const L = leaflet.current;
    const instance = map.current;
    const layer = markers.current;
    if (!L || !instance || !layer) return;
    renderPositions(L, instance, layer, positions);
  }, [positions]);

  return <div className="live-map" ref={element} aria-label="Posición actual de los guardias" />;
}

function renderPositions(
  L: typeof import('leaflet'),
  map: LeafletMap,
  layer: LayerGroup,
  positions: LivePosition[],
): void {
  layer.clearLayers();
  const bounds = L.latLngBounds([]);
  for (const position of positions) {
    const point = L.latLng(position.latitude, position.longitude);
    bounds.extend(point);
    L.circleMarker(point, {
      radius: 8, color: '#173b8f', fillColor: '#4263eb', fillOpacity: 0.9, weight: 2,
    }).bindPopup(
      `<strong>${escapeHtml(position.guardName)}</strong><br>${escapeHtml(position.siteName)}<br>` +
      `Actualizado ${new Date(position.recordedAt).toLocaleTimeString('es-CL')}`,
    ).addTo(layer);
  }
  if (bounds.isValid()) map.fitBounds(bounds.pad(0.25), { maxZoom: 17 });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character] ?? character);
}
