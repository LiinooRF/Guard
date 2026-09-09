'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import type { CheckpointKind } from '@sentrycore/shared';

import type { PoliticaFoto } from './guard-shift-state';
import { traducirEstadoPermiso } from './guard-permiso-ubicacion';
import { useGuardBridge } from './use-guard-bridge';

export interface GuardHomeData {
  hasAssignment: boolean;
  message?: string;
  assignedSites?: Array<{
    id: string;
    name: string;
    branchName?: string;
  }>;
  selectedSiteId?: string;
  /**
   * Rutas que el guardia puede recorrer por su cuenta, sin que se la asignen
   * (#133). La API las manda solo cuando NO tiene ronda abierta, porque con una
   * en marcha el servidor rechaza la voluntaria.
   */
  voluntaryRoutes?: Array<{
    id: string;
    name: string;
    siteId: string;
    siteName: string;
    checkpointCount: number;
  }>;
  shift?: {
    scheduledStartAt: string;
    scheduledEndAt: string;
  };
  /** Presupuesto de compresion de foto, resuelto por la API en la cascada del recinto. */
  photoBudget?: { targetBytes: number; maxBytes: number };
  /**
   * Regla `allowQrFallback` del recinto (#227). Opcional: un portal nuevo contra
   * una API todavia sin desplegar no la recibe, y ahi se asume permitida —es el
   * valor por omision del catalogo—, porque dejar al guardia sin ningun camino
   * es peor que ofrecerle uno que la API podria rechazar.
   */
  qrFallbackEnabled?: boolean;
  /**
   * Horario habil del recinto y reglas de foto. Viaja hasta GuardShift, que es
   * quien decide punto a punto con isPhotoRequired() de @sentrycore/shared.
   */
  photoPolicy?: PoliticaFoto;
  patrol?: {
    id: string;
    status: 'pendiente' | 'en_curso';
    siteId?: string;
    siteName: string;
    /** Zona horaria del RECINTO. La marca de agua de la foto la usa. */
    timezone?: string;
    routeName: string;
    estimatedDurationMin: number;
    completedCheckpointCount: number;
    checkpoints: Array<{
      id: string;
      name: string;
      position: number;
      isClosingPoint?: boolean;
      // 'acceso_critico' = ademas de marcar hay que fotografiar la puerta.
      kind?: CheckpointKind;
      // Override tri-estado del punto sobre la regla de foto.
      requiresPhoto?: boolean | null;
      // Un punto puede no estar geolocalizado; el mapa lo omite.
      latitude?: number | null;
      longitude?: number | null;
      tagUids: string[];
    }>;
  };
  synchronization: { pendingItems: number };
}

const time = new Intl.DateTimeFormat('es-CL', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Santiago',
});

export function GuardHome({ data, apiUrl }: { data: GuardHomeData; apiUrl: string }) {
  const router = useRouter();
  const puente = useGuardBridge(apiUrl);
  const guardarRutaOffline = puente.guardarRutaOffline;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();
  const rutasVoluntarias = data.voluntaryRoutes ?? [];
  const [rutaElegida, setRutaElegida] = useState<string>('');
  const [iniciandoVoluntaria, setIniciandoVoluntaria] = useState(false);
  const [errorVoluntaria, setErrorVoluntaria] = useState<string>();

  /**
   * Arranca una ronda que nadie programo.
   *
   * Existe para que el recorrido no sea predecible: un guardia que siempre pasa
   * a la misma hora le regala el horario a quien quiere entrar. Por eso la
   * puede lanzar cuando quiera, y por eso el informe la marca como voluntaria
   * en vez de mezclarla con las programadas.
   */
  async function iniciarRondaVoluntaria(routeId: string) {
    setIniciandoVoluntaria(true);
    setErrorVoluntaria(undefined);
    try {
      const respuesta = await fetch(`${apiUrl}/guard/routes/${routeId}/voluntary-patrol`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!respuesta.ok) {
        const cuerpo = (await respuesta.json().catch(() => null)) as { message?: string } | null;
        throw new Error(cuerpo?.message ?? 'No pudimos iniciar la ronda voluntaria');
      }
      router.refresh();
    } catch (e) {
      setErrorVoluntaria(e instanceof Error ? e.message : 'No pudimos iniciar la ronda voluntaria');
    } finally {
      setIniciandoVoluntaria(false);
    }
  }

  /*
   * El permiso de notificaciones se pide al ver el turno, no al arrancar.
   *
   * Aca ya hay contexto: el guardia esta mirando su ronda, y los avisos que va
   * a recibir son de eso —el pánico de un companero, un cambio de turno—.
   * Pedirlo en la pantalla de carga, sin que sepa para que, es la forma mas
   * eficiente de quemar los dos intentos que Android concede antes de dejar de
   * mostrar el dialogo para siempre.
   *
   * Se pide una sola vez por montaje y no bloquea nada: si dice que no, la
   * ronda funciona igual.
   */
  useEffect(() => {
    // Recien cuando el shell saludo: antes de eso `pedirPermiso` rechaza con
    // 'sin-puente' y el catch se lo traga, que fue exactamente lo que paso la
    // primera vez que se probo esto en el telefono —el dialogo no aparecia y
    // no habia ningun error a la vista—.
    if (puente.fase !== 'listo') return;
    void puente.pedirPermiso('notificaciones', true).catch(() => undefined);
  }, [puente, puente.fase]);

  useEffect(() => {
    if (!data.hasAssignment || !data.patrol || !data.shift) return;
    void guardarRutaOffline({
      patrolId: data.patrol.id,
      status: data.patrol.status,
      siteName: data.patrol.siteName,
      routeName: data.patrol.routeName,
      scheduledStartAt: data.shift.scheduledStartAt,
      scheduledEndAt: data.shift.scheduledEndAt,
      estimatedDurationMin: data.patrol.estimatedDurationMin,
      checkpoints: data.patrol.checkpoints,
    }).catch(() => undefined);
  }, [data, guardarRutaOffline]);

  if (!data.hasAssignment || !data.patrol || !data.shift) {
    return (
      <section className="empty-assignment" aria-live="polite">
        <span className="empty-icon">✓</span>
        {data.assignedSites && data.assignedSites.length > 1 ? (
          <div className="guard-site-selector-row" style={{ marginBottom: '1.25rem', width: '100%', maxWidth: '340px' }}>
            <label style={{ fontSize: '0.85rem', fontWeight: 600, color: '#334155', display: 'flex', flexDirection: 'column', gap: '0.35rem', textAlign: 'left' }}>
              <span>📍 Seleccionar recinto asignado:</span>
              <select
                value={data.selectedSiteId ?? ''}
                onChange={(e) => {
                  router.push(`/app/guardia?siteId=${e.target.value}`);
                }}
                style={{ width: '100%', padding: '0.5rem 0.75rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.95rem', backgroundColor: '#f8fafc', color: '#0f172a' }}
              >
                {data.assignedSites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.branchName ? `${site.branchName} · ${site.name}` : site.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
        <h2>No tienes una ronda asignada</h2>
        <p>{data.message ?? 'Cuando te asignen una ronda, aparecerá aquí automáticamente.'}</p>

        {/*
          * Ronda voluntaria (#133).
          *
          * Se ofrece SOLO aca, sin ronda abierta: con una en marcha el servidor
          * la rechaza, y un boton que falla es peor que no tenerlo. El texto
          * dice para que sirve, porque un guardia no tiene por que adivinar por
          * que le conviene salir a una hora que nadie le fijo.
          */}
        {rutasVoluntarias.length > 0 ? (
          <div className="ronda-voluntaria">
            <h3>Ronda voluntaria</h3>
            <p>
              Puedes recorrer una ronda cuando quieras, sin esperar a que te la asignen. Queda
              registrada igual, con tu recorrido y tus marcas.
            </p>
            {rutasVoluntarias.length > 1 ? (
              <label className="ronda-voluntaria-ruta">
                <span>¿Qué ronda vas a hacer?</span>
                <select
                  value={rutaElegida}
                  onChange={(evento) => setRutaElegida(evento.target.value)}
                >
                  <option value="">Elige una…</option>
                  {rutasVoluntarias.map((ruta) => (
                    <option key={ruta.id} value={ruta.id}>
                      {ruta.name} · {ruta.checkpointCount} puntos
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <button
              className="primary-button"
              disabled={
                iniciandoVoluntaria ||
                (rutasVoluntarias.length > 1 && rutaElegida === '')
              }
              onClick={() =>
                iniciarRondaVoluntaria(
                  rutasVoluntarias.length === 1 ? rutasVoluntarias[0]!.id : rutaElegida,
                )
              }
              type="button"
            >
              {iniciandoVoluntaria ? 'Iniciando…' : 'Iniciar ronda voluntaria'}
            </button>
            {errorVoluntaria ? (
              <p className="ronda-voluntaria-error" role="alert">
                {errorVoluntaria}
              </p>
            ) : null}
          </div>
        ) : null}

        <ConnectionStatus pendingItems={data.synchronization.pendingItems} />
      </section>
    );
  }

  const { patrol, shift } = data;
  const total = patrol.checkpoints.length;
  const completed = patrol.completedCheckpointCount;
  const pending = patrol.status === 'pendiente';

  async function startPatrol() {
    setStarting(true);
    setError(undefined);
    try {
      /*
       * Sincronizar el estado de permiso de ubicación con el backend antes de iniciar.
       * Si el puente está activo, se solicita ubicación en segundo plano y se
       * reporta el estado actualizado a POST /geo/permission para que el backend
       * (assertPatrolStartAllowed) no rebote con 'sin_reporte_de_permiso'.
       */
      if (puente.fase === 'listo') {
        const resultadoSegundoPlano = await puente
          .pedirPermiso('ubicacion-segundo-plano', true)
          .catch(() => undefined);
        if (resultadoSegundoPlano) {
          const estadoApi = traducirEstadoPermiso(resultadoSegundoPlano.estado);
          await fetch(`${apiUrl}/geo/permission`, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              status: estadoApi,
              deviceInfo: puente.infoEquipo ?? 'android app',
            }),
          }).catch(() => undefined);
        } else {
          await puente.refrescarPermisoUbicacion().catch(() => undefined);
        }
      } else {
        await puente.refrescarPermisoUbicacion().catch(() => undefined);
      }

      const response = await fetch(`${apiUrl}/guard/patrols/${patrol.id}/start`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-SentryCore-Request': 'web' },
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { message?: string } | null;
        throw new Error(body?.message ?? 'No pudimos iniciar la ronda');
      }
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No pudimos iniciar la ronda');
    } finally {
      setStarting(false);
    }
  }

  return (
    <>
      {puente.avisoUbicacion ? (
        <p className="guardia-anuncio guardia-anuncio-alerta" role="alert">
          {puente.avisoUbicacion}
        </p>
      ) : null}
      <section className="guard-focus-card" id="operacion">
        <div className="guard-status-row">
          <span className={`status-pill ${pending ? 'pending' : 'active'}`}>
            {pending ? 'Lista para iniciar' : 'Ronda en curso'}
          </span>
          <ConnectionStatus pendingItems={data.synchronization.pendingItems} compact />
        </div>

        {data.assignedSites && data.assignedSites.length > 1 ? (
          <div className="guard-site-selector-row" style={{ marginTop: '0.5rem', marginBottom: '0.75rem' }}>
            <label style={{ fontSize: '0.85rem', fontWeight: 600, color: '#475569', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <span>📍 Cambiar de recinto asignado:</span>
              <select
                value={data.selectedSiteId ?? patrol.siteId ?? ''}
                onChange={(e) => {
                  router.push(`/app/guardia?siteId=${e.target.value}`);
                }}
                style={{ padding: '0.45rem 0.7rem', borderRadius: '0.375rem', border: '1px solid #cbd5e1', fontSize: '0.9rem', backgroundColor: '#f8fafc', color: '#0f172a' }}
              >
                {data.assignedSites.map((site) => (
                  <option key={site.id} value={site.id}>
                    {site.branchName ? `${site.branchName} · ${site.name}` : site.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}

        <span className="eyebrow">Tu tarea ahora</span>
        <h2>Ronda en {patrol.siteName}</h2>
        <p className="guard-site" style={{ fontSize: '1.05rem', fontWeight: 600, color: '#1e293b' }}>
          {patrol.routeName}
        </p>

        {pending ? (
          <button className="guard-primary-action" type="button" onClick={startPatrol} disabled={starting}>
            {starting ? 'Iniciando…' : `Iniciar ronda en ${patrol.siteName}`}
          </button>
        ) : null}
        {/* No hay boton de escanear aca: con la ronda en curso, la pagina monta
            GuardShift, que es donde vive el escaneo de verdad. Lo que habia era
            un <button> sin onClick — se veia igual que uno funcionando y no
            hacia nada. */}
        {error ? <p className="guard-action-error" role="alert">{error}</p> : null}

        <div className="guard-shift-grid">
          <span><small>Ronda</small><strong>{time.format(new Date(shift.scheduledStartAt))} — {time.format(new Date(shift.scheduledEndAt))}</strong></span>
          <span><small>Progreso</small><strong>{completed} de {total} puntos</strong></span>
          <span><small>Duración estimada</small><strong>{patrol.estimatedDurationMin} min</strong></span>
        </div>

      </section>
    </>
  );
}

function ConnectionStatus({
  pendingItems,
  compact = false,
}: {
  pendingItems: number;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'connection-status compact' : 'connection-status'}>
      <span><i /> En línea</span>
      <span>{pendingItems === 0 ? 'Todo sincronizado' : `${pendingItems} pendientes`}</span>
    </div>
  );
}
