'use client';

import { useEffect, useRef } from 'react';
import type { LayerGroup, Map as LeafletMap } from 'leaflet';
import { formatearAtribucionTileLayer, resolverOrigenTiles } from './mapa-tiles';
import { COLOR_SECUNDARIO_MARCA } from './mapa-colores';
import { esCoordenadaValida, formatearPrecisionGps, UMBRAL_GPS_IMPRECISO_M } from './mapa-modelo';

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
  const hasAutoFit = useRef(false);
  latestPositions.current = positions;

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    let disposed = false;

    void import('leaflet').then((L) => {
      if (disposed || !element.current) return;
      leaflet.current = L;
      const instance = L.map(element.current, {
        zoomControl: true,
        preferCanvas: true,
        scrollWheelZoom: false,
      });
      map.current = instance;

      // El origen pasa por resolverOrigenTiles() y no se usa crudo: es lo que
      // impide que un MAP_TILE_URL apuntando a tile.openstreetmap.org termine
      // sirviendo tiles publicos en produccion, cosa que su politica de uso
      // prohibe y por la que bloquean a quien la incumple.
      const origen = resolverOrigenTiles({
        url: tileUrl || undefined,
        atribucion: attribution || undefined,
        produccion: process.env.NODE_ENV === 'production',
      });

      if (origen.url) {
        L.tileLayer(origen.url, {
          attribution: formatearAtribucionTileLayer(origen.atribucionProveedor ?? attribution),
          maxZoom: origen.maxZoom,
          updateWhenIdle: true,
          keepBuffer: 1,
        }).addTo(instance);
      }

      markers.current = L.layerGroup().addTo(instance);
      renderPositions(L, instance, markers.current, latestPositions.current, hasAutoFit, true);
    });

    return () => {
      disposed = true;
      map.current?.remove();
      map.current = null;
      markers.current = null;
      leaflet.current = null;
      hasAutoFit.current = false;
    };
  }, [attribution, tileUrl]);

  useEffect(() => {
    const L = leaflet.current;
    const instance = map.current;
    const layer = markers.current;
    if (!L || !instance || !layer) return;
    renderPositions(L, instance, layer, positions, hasAutoFit, false);
  }, [positions]);

  return <div className="live-map" ref={element} aria-label="Posición actual de los guardias" />;
}

export function renderPositions(
  L: typeof import('leaflet'),
  map: LeafletMap,
  layer: LayerGroup,
  positions: LivePosition[],
  hasAutoFitRef: { current: boolean },
  forceFit = false,
): void {
  layer.clearLayers();
  const bounds = L.latLngBounds([]);
  const validPositions = positions.filter((p) => esCoordenadaValida(p.latitude, p.longitude));

  for (const position of validPositions) {
    const point = L.latLng(position.latitude, position.longitude);
    bounds.extend(point);

    const isEstimated =
      typeof position.accuracyM === 'number' && position.accuracyM > UMBRAL_GPS_IMPRECISO_M;

    // Si tiene radio de precisión, dibujamos un círculo tenue de incertidumbre
    if (typeof position.accuracyM === 'number' && position.accuracyM > 0) {
      L.circle(point, {
        radius: Math.min(position.accuracyM, 300),
        color: isEstimated ? '#f59f00' : COLOR_SECUNDARIO_MARCA,
        weight: 1,
        dashArray: isEstimated ? '4 4' : undefined,
        fillColor: isEstimated ? '#f59f00' : COLOR_SECUNDARIO_MARCA,
        fillOpacity: isEstimated ? 0.12 : 0.08,
      }).addTo(layer);
    }

    // Marcador sobrio del guardia con borde blanco limpio
    const marker = L.circleMarker(point, {
      radius: 8,
      color: '#ffffff',
      weight: 2,
      fillColor: isEstimated ? '#f59f00' : COLOR_SECUNDARIO_MARCA,
      fillOpacity: 1,
    });

    const horaTexto = formatearHoraLocal(position.recordedAt);
    const precisionTexto = formatearPrecisionGps(position.accuracyM);
    const badgeHtml = isEstimated
      ? `<span style="display:inline-block;padding:2px 6px;margin-top:3px;border-radius:4px;background:#fff9db;color:#916217;font-size:10px;font-weight:700;">Señal estimada / subterráneo</span><br>`
      : '';

    marker.bindPopup(
      `<div style="font-size:12px;line-height:1.4;">` +
        `<strong>${escapeHtml(position.guardName)}</strong><br>` +
        `<span style="color:#4d566b;">${escapeHtml(position.siteName)}</span><br>` +
        badgeHtml +
        `<small style="color:#687086;">Actualizado: ${horaTexto}<br>${precisionTexto}</small>` +
        `</div>`,
    );

    marker.addTo(layer);
  }

  // Auto-fit solo en la primera carga o cuando se fuerza, para evitar parpadeos y
  // saltos de cámara mientras el supervisor inspecciona el mapa
  if (bounds.isValid() && (!hasAutoFitRef.current || forceFit)) {
    map.fitBounds(bounds.pad(0.25), { maxZoom: 17 });
    hasAutoFitRef.current = true;
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  })[character] ?? character);
}

function formatearHoraLocal(recordedAt: string): string {
  try {
    return new Date(recordedAt).toLocaleTimeString('es-CL', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return recordedAt;
  }
}
