/**
 * Pruebas unitarias para los helpers y la lógica del mapa en vivo (#97 / #134).
 *
 * Cubre:
 * - Filtrado de coordenadas inválidas y (0,0) para evitar que posiciones caigan en el océano.
 * - Tratamiento visual sobrio de señales GPS imprecisas / subterráneas (> 50m).
 * - Escape seguro de HTML en popups contra inyecciones XSS.
 * - Comportamiento anti-parpadeo (anti-flickering) del auto-fit para no saltar la cámara en cada sondeo.
 */

import type { LayerGroup, Map as LeafletMap } from 'leaflet';
import { escapeHtml, renderPositions, type LivePosition } from './live-guard-map';

describe('LiveMap - escapeHtml', () => {
  it('escapa caracteres especiales para prevenir inyección HTML en popups', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml("Guardia 'Juan' & Cía")).toBe('Guardia &#39;Juan&#39; &amp; Cía');
  });

  it('mantiene texto limpio sin alteraciones', () => {
    expect(escapeHtml('Patrulla Norte')).toBe('Patrulla Norte');
  });
});

describe('LiveMap - renderPositions', () => {
  const mockMarker = {
    bindPopup: jest.fn().mockReturnThis(),
    addTo: jest.fn().mockReturnThis(),
  };
  const mockCircle = {
    addTo: jest.fn().mockReturnThis(),
  };
  const mockBounds = {
    extend: jest.fn().mockReturnThis(),
    pad: jest.fn().mockReturnThis(),
    isValid: jest.fn().mockReturnValue(true),
  };
  const mockMap = {
    fitBounds: jest.fn(),
  } as unknown as LeafletMap;
  const mockLayer = {
    clearLayers: jest.fn(),
  } as unknown as LayerGroup;

  const mockLeaflet = {
    latLng: jest.fn((lat: number, lng: number) => ({ lat, lng })),
    latLngBounds: jest.fn(() => mockBounds),
    circleMarker: jest.fn(() => mockMarker),
    circle: jest.fn(() => mockCircle),
  } as unknown as typeof import('leaflet');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  const guardiaOptimo: LivePosition = {
    patrolId: 'pat-1',
    guardName: 'Carlos Vera',
    siteName: 'Bodega Central',
    latitude: -33.4489,
    longitude: -70.6693,
    recordedAt: '2026-08-19T13:00:00.000Z',
    accuracyM: 12,
  };

  const guardiaSubterraneo: LivePosition = {
    patrolId: 'pat-2',
    guardName: 'Roberto Gómez',
    siteName: 'Subterráneo -2',
    latitude: -33.4495,
    longitude: -70.6701,
    recordedAt: '2026-08-19T13:02:00.000Z',
    accuracyM: 95, // impreciso / subterráneo
  };

  const posicionInvalida: LivePosition = {
    patrolId: 'pat-3',
    guardName: 'Sin Señal',
    siteName: 'Perímetro',
    latitude: 0,
    longitude: 0,
    recordedAt: '2026-08-19T13:00:00.000Z',
    accuracyM: null,
  };

  it('limpia las capas anteriores y descarta coordenadas inválidas', () => {
    const hasAutoFit = { current: false };
    renderPositions(
      mockLeaflet,
      mockMap,
      mockLayer,
      [guardiaOptimo, posicionInvalida],
      hasAutoFit,
      true,
    );

    expect(mockLayer.clearLayers).toHaveBeenCalledTimes(1);
    // Solo el punto óptimo debe dibujarse; el (0,0) se descarta
    expect(mockLeaflet.circleMarker).toHaveBeenCalledTimes(1);
  });

  it('dibuja marcador óptimo con radio de precisión tenue', () => {
    const hasAutoFit = { current: false };
    renderPositions(
      mockLeaflet,
      mockMap,
      mockLayer,
      [guardiaOptimo],
      hasAutoFit,
      true,
    );

    expect(mockLeaflet.circle).toHaveBeenCalledWith(
      { lat: -33.4489, lng: -70.6693 },
      expect.objectContaining({
        radius: 12,
        fillOpacity: 0.08,
      }),
    );
    expect(mockLeaflet.circleMarker).toHaveBeenCalledWith(
      { lat: -33.4489, lng: -70.6693 },
      expect.objectContaining({
        color: '#ffffff',
        fillOpacity: 1,
      }),
    );
    expect(mockMarker.bindPopup).toHaveBeenCalled();
  });

  it('dibuja marcador con estilo de señal estimada / subterráneo cuando accuracyM > 50', () => {
    const hasAutoFit = { current: false };
    renderPositions(
      mockLeaflet,
      mockMap,
      mockLayer,
      [guardiaSubterraneo],
      hasAutoFit,
      true,
    );

    expect(mockLeaflet.circle).toHaveBeenCalledWith(
      { lat: -33.4495, lng: -70.6701 },
      expect.objectContaining({
        color: '#f59f00',
        fillColor: '#f59f00',
        dashArray: '4 4',
      }),
    );
    expect(mockLeaflet.circleMarker).toHaveBeenCalledWith(
      { lat: -33.4495, lng: -70.6701 },
      expect.objectContaining({
        fillColor: '#f59f00',
      }),
    );
    const popupHtml = mockMarker.bindPopup.mock.calls[0][0];
    expect(popupHtml).toContain('Señal estimada / subterráneo');
  });

  it('auto-fit solo se ejecuta en la carga inicial y no en refrescos periódicos para evitar parpadeo', () => {
    const hasAutoFit = { current: false };

    // Primer render (inicial): fitBounds se ejecuta
    renderPositions(
      mockLeaflet,
      mockMap,
      mockLayer,
      [guardiaOptimo],
      hasAutoFit,
      true,
    );
    expect(mockMap.fitBounds).toHaveBeenCalledTimes(1);
    expect(hasAutoFit.current).toBe(true);

    // Segundo render (refresco cada 5s): fitBounds NO se vuelve a ejecutar
    renderPositions(
      mockLeaflet,
      mockMap,
      mockLayer,
      [guardiaOptimo],
      hasAutoFit,
      false,
    );
    expect(mockMap.fitBounds).toHaveBeenCalledTimes(1);
  });
});
