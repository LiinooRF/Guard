'use client';

import { useEffect, useMemo, useState } from 'react';

import { MapaBase } from './mapa-base';
import { resolverOrigenTiles } from './mapa-tiles';
import {
  marcasDeCheckpoints,
  trazaDePatronCheckpoints,
  trazaDeRecorrido,
  type RespuestaTrack,
} from './recorrido-modelo';
import type { PuntoMapa, TrazaMapa } from './mapa-modelo';

/**
 * Recorrido de una ronda sobre el mapa (#134): la traza completa del guardia,
 * además de los puntos escaneados que ya muestra el tablero, con la superposición
 * de la ronda patrón planificada.
 *
 * Lee `GET /geo/patrols/:id/track` (permiso `patrols:monitor`, del supervisor) y
 * la dibuja con `MapaBase`, que ya cae a una lista si Leaflet no carga. Si el
 * tenant tiene el seguimiento apagado o el consentimiento no está vigente, el
 * endpoint devuelve el recorrido vacío y se dice tal cual, sin inventar un mapa.
 */
export function RecorridoPatrulla({
  apiUrl,
  patrolId,
  tileUrl,
  attribution,
}: {
  apiUrl: string;
  patrolId: string;
  tileUrl: string | null;
  attribution: string;
}) {
  const [estado, setEstado] = useState<'cargando' | 'listo' | 'vacio' | 'error'>('cargando');
  const [trazas, setTrazas] = useState<TrazaMapa[]>([]);
  const [puntos, setPuntos] = useState<PuntoMapa[]>([]);
  const [resumen, setResumen] = useState<{ km: string; min: number } | null>(null);

  const origen = useMemo(
    () =>
      resolverOrigenTiles({
        ...(tileUrl ? { url: tileUrl } : {}),
        atribucion: attribution,
        produccion: process.env.NODE_ENV === 'production',
      }),
    [tileUrl, attribution],
  );

  useEffect(() => {
    let vivo = true;
    setEstado('cargando');
    void (async () => {
      try {
        const respuesta = await fetch(`${apiUrl}/geo/patrols/${patrolId}/track`, {
          credentials: 'include',
          cache: 'no-store',
        });
        if (!respuesta.ok) throw new Error(String(respuesta.status));
        const cuerpo = (await respuesta.json()) as RespuestaTrack;
        if (!vivo) return;
        const lineaRecorrido = trazaDeRecorrido(cuerpo.points ?? []);
        const lineaPatron = cuerpo.checkpoints ? trazaDePatronCheckpoints(cuerpo.checkpoints) : null;
        const marcasPuntos = cuerpo.checkpoints ? marcasDeCheckpoints(cuerpo.checkpoints) : [];
        const listaTrazas = [lineaPatron, lineaRecorrido].filter((t): t is TrazaMapa => t !== null);

        if (listaTrazas.length === 0 && marcasPuntos.length === 0) {
          setEstado('vacio');
          return;
        }

        setTrazas(listaTrazas);
        setPuntos(marcasPuntos);
        setResumen({
          km: ((cuerpo.totalDistanceM ?? 0) / 1000).toFixed(2),
          min: Math.round(cuerpo.durationMin ?? 0),
        });
        setEstado('listo');
      } catch {
        if (vivo) setEstado('error');
      }
    })();
    return () => {
      vivo = false;
    };
  }, [apiUrl, patrolId]);

  if (estado === 'cargando') {
    return <p className="live-map-empty">Cargando el recorrido…</p>;
  }
  if (estado === 'error') {
    return (
      <p className="live-error" role="alert">
        No pudimos cargar el recorrido. Reintenta en unos segundos.
      </p>
    );
  }
  if (estado === 'vacio' || (trazas.length === 0 && puntos.length === 0)) {
    return (
      <p className="live-map-empty">
        Esta ronda todavía no tiene recorrido ni puntos registrados.
      </p>
    );
  }

  return (
    <div className="patrulla-recorrido">
      <MapaBase
        etiqueta="Recorrido de la ronda"
        puntos={puntos}
        trazas={trazas}
        origen={origen}
        alto="240px"
      />
      {resumen ? (
        <p className="live-refreshed">
          Recorrido: {resumen.km} km · {resumen.min} min
        </p>
      ) : null}
    </div>
  );
}
