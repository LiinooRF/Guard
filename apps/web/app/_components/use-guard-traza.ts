'use client';

import { useEffect, useRef } from 'react';

import { acumular, colaVacia, loteParaEnviar, trasEnviar, type ColaDeTraza } from './guard-traza';
import type { PuenteGuardia } from './use-guard-bridge';

/**
 * El emisor de la traza en vivo (#280): enciende el muestreo del shell mientras
 * la ronda esta en curso y sube cada posicion con la sesion del guardia.
 *
 * Vive en un hook aparte —no dentro de use-guard-bridge— porque el puente no
 * sabe de rondas: encender y apagar el grifo es una decision de la PANTALLA de
 * la ronda, y "no se rastrea fuera del turno" exige que el apagado acompañe al
 * componente. El desmontaje (cierre de ronda, navegacion, logout) manda
 * `track.stop` pase lo que pase; el shell ademas corta solo si el WebView se
 * recarga, y el servidor rechaza lo que llegue fuera de la ventana. Tres
 * capas para la misma promesa legal.
 */
export function useTrazaEnVivo({
  puente,
  apiUrl,
  patrolId,
  activa,
}: {
  puente: PuenteGuardia;
  apiUrl: string;
  patrolId: string;
  /** La ronda sigue abierta. Con el cierre puesto, el grifo se corta. */
  activa: boolean;
}) {
  // La cola vive en un ref: cada punto nuevo no tiene por que re-renderizar la
  // pantalla del guardia, que bastante hace dibujando la ronda.
  const cola = useRef<ColaDeTraza>(colaVacia());
  const enviando = useRef(false);

  useEffect(() => {
    if (!activa || !puente.soportaTraza) return undefined;

    let cancelado = false;

    async function subir() {
      // Un solo POST en vuelo: el shell emite por intervalo y un servidor
      // lento no debe apilar requests identicos.
      if (enviando.current) return;
      const lote = loteParaEnviar(cola.current);
      if (lote.length === 0) return;
      enviando.current = true;
      try {
        const respuesta = await fetch(`${apiUrl}/geo/patrols/${patrolId}/track`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ points: lote }),
        });
        // 4xx = la politica hablando (consentimiento revocado, ventana
        // cerrada): el lote se descarta. 5xx = mala suerte: se conserva.
        const resultado = respuesta.ok
          ? 'enviado'
          : respuesta.status >= 500
            ? 'fallo-red'
            : 'rechazado';
        if (!cancelado) cola.current = trasEnviar(cola.current, lote.length, resultado);
      } catch {
        // Sin señal: la cola conserva todo y el proximo punto reintenta. Es la
        // regla 4 de CLAUDE.md — el guardia trabaja donde no hay señal.
      } finally {
        enviando.current = false;
      }
    }

    /*
     * El intervalo sale del PLAN del servidor (GET /geo/policy), no de un
     * numero del cliente: es la misma regla que el aviso legal le mostro al
     * guardia ("una posicion cada N segundos"). Si la politica dice que con
     * este estado no se registra recorrido (sin consentimiento, seguimiento
     * apagado en la empresa), el grifo ni se abre.
     */
    void (async () => {
      try {
        const respuesta = await fetch(`${apiUrl}/geo/policy`, { credentials: 'include' });
        if (!respuesta.ok || cancelado) return;
        const politica = (await respuesta.json()) as {
          tracksLocation?: boolean;
          sampling?: { intervalSeconds?: number };
        };
        if (!politica.tracksLocation || cancelado) return;
        puente.iniciarTraza(politica.sampling?.intervalSeconds ?? 60);
      } catch {
        // Sin politica no hay traza. La ronda sigue: la traza es contexto,
        // nunca condicion.
      }
    })();

    const baja = puente.alPuntoDeTraza((punto) => {
      cola.current = acumular(cola.current, punto);
      void subir();
    });

    return () => {
      cancelado = true;
      baja();
      puente.detenerTraza();
    };
  }, [activa, apiUrl, patrolId, puente]);
}
