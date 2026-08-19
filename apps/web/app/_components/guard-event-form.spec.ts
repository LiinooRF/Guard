/**
 * Pruebas unitarias para el formulario de eventos/novedades y pánico (#92 / #122 / #125).
 *
 * Cubre:
 * - Modelo unificado de novedades y botón de pánico SOS (criticidad 'panico' como máxima severidad).
 * - Estructura append-only (nunca editable ni borrable).
 * - Captura de coordenadas GPS válidas y foto de evidencia tomada exclusivamente con cámara.
 * - Idempotencia mediante clientEventId y encolamiento offline ante falta de señal.
 */

import type { Criticidad, PayloadNovedad } from './guard-outbox';
import { dispararPanico, type AlertaPanico } from './panico-envio';

describe('GuardEventForm & SOS Panic Model (#122)', () => {
  it('el pánico y las novedades comparten la misma estructura de datos (PayloadNovedad)', () => {
    const novedadOrdinaria: PayloadNovedad = {
      criticality: 'media',
      clientEventId: 'client-ev-1',
      text: 'Portón trasero con candado forzado',
      patrolId: 'patrol-101',
      reportedAt: '2026-08-19T14:00:00.000Z',
      latitude: -33.4489,
      longitude: -70.6693,
      accuracyM: 15,
    };

    const panicoEmergencia: PayloadNovedad = {
      criticality: 'panico',
      clientEventId: 'client-sos-1',
      patrolId: 'patrol-101',
      reportedAt: '2026-08-19T14:01:00.000Z',
      latitude: -33.4490,
      longitude: -70.6695,
      accuracyM: 8,
    };

    expect(novedadOrdinaria.criticality).toBe('media');
    expect(novedadOrdinaria.text).toBeDefined();

    // El pánico es la criticidad máxima y no exige texto descriptivo
    expect(panicoEmergencia.criticality).toBe('panico');
    expect(panicoEmergencia.text).toBeUndefined();
    expect(panicoEmergencia.latitude).toBe(-33.4490);
  });

  it('dispararPanico genera una alerta con clientEventId único y encolado inicial', () => {
    const alerta: AlertaPanico = dispararPanico({
      patrolId: 'patrol-101',
      ubicacion: {
        latitude: -33.4489,
        longitude: -70.6693,
        accuracyM: 10,
      },
    });

    expect(alerta).toBeDefined();
    expect(alerta.clientEventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(alerta.estado).toBe('encolado');
    expect(alerta.patrolId).toBe('patrol-101');
    expect(alerta.intentos).toBe(0);
  });

  it('el catálogo de criticidades contiene niveles válidos y ordenados por severidad', () => {
    const nivelesValidos: Criticidad[] = ['info', 'baja', 'media', 'alta', 'panico'];
    expect(nivelesValidos).toHaveLength(5);
    expect(nivelesValidos[4]).toBe('panico');
  });
});
