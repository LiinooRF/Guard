'use client';

import { useState } from 'react';

export interface RondaInformable {
  id: string;
  siteName: string;
  routeName: string;
  status: string;
  scheduledStartAt: string;
}

interface FotoMeta {
  id: string;
  checkpointName?: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

interface FotoVisible extends FotoMeta {
  url: string;
}

type EstadoAnexo =
  | { fase: 'cerrado' }
  | { fase: 'cargando'; patrolId: string }
  | { fase: 'listo'; patrolId: string; fotos: FotoVisible[] }
  | { fase: 'vacio'; patrolId: string }
  | { fase: 'error'; patrolId: string; mensaje: string };

const ESTADO_TEXTO: Record<string, string> = {
  completed: 'Completada',
  in_progress: 'En curso',
  pending: 'Pendiente',
  expired: 'Vencida',
  missed: 'No realizada',
};

function fecha(iso: string): string {
  return new Date(iso).toLocaleString('es-CL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function pesoLegible(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(bytes / 1024)} KB`;
}

/**
 * Informes de ronda y su anexo fotografico (#88).
 *
 * Dos decisiones que se ven raras y son deliberadas:
 *
 * 1. El PDF se baja con un enlace normal y no con fetch + blob. La sesion vive
 *    en una cookie HttpOnly —que JavaScript no puede leer, y esta bien que asi
 *    sea—, de modo que el navegador la manda solo si la peticion la hace el, no
 *    nosotros. De paso sale gratis la barra de descargas del navegador.
 *
 * 2. Las fotos se piden al ABRIR el anexo, no al cargar la pagina. Cada una
 *    necesita un enlace firmado que dura cinco minutos: pedirlos todos por
 *    adelantado dejaria la mitad vencidos antes de que alguien los mire.
 */
export function InformesPanel({
  rondas,
  apiUrl,
}: {
  rondas: RondaInformable[];
  apiUrl: string;
}) {
  const [anexo, setAnexo] = useState<EstadoAnexo>({ fase: 'cerrado' });

  async function abrirAnexo(patrolId: string) {
    if (anexo.fase !== 'cerrado' && anexo.patrolId === patrolId) {
      setAnexo({ fase: 'cerrado' });
      return;
    }
    setAnexo({ fase: 'cargando', patrolId });
    try {
      const respuesta = await fetch(`${apiUrl}/evidence/patrols/${patrolId}/photos`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!respuesta.ok) {
        setAnexo({
          fase: 'error',
          patrolId,
          mensaje:
            respuesta.status === 403
              ? 'No tienes este recinto asignado.'
              : 'No pudimos cargar las fotos de esta ronda.',
        });
        return;
      }
      const datos = (await respuesta.json()) as { photos: FotoMeta[] };
      if (!datos.photos.length) {
        setAnexo({ fase: 'vacio', patrolId });
        return;
      }

      // Un enlace firmado por foto. Si una falla se omite esa y no el anexo
      // entero: un informe con nueve fotos de diez sigue sirviendo.
      const enlaces = await Promise.all(
        datos.photos.map(async (foto) => {
          try {
            const r = await fetch(`${apiUrl}/evidence/photos/${foto.id}/link`, {
              credentials: 'include',
              cache: 'no-store',
            });
            if (!r.ok) return null;
            const { url } = (await r.json()) as { url: string };
            return { ...foto, url };
          } catch {
            return null;
          }
        }),
      );
      const visibles = enlaces.filter((f): f is FotoVisible => f !== null);
      setAnexo(
        visibles.length
          ? { fase: 'listo', patrolId, fotos: visibles }
          : { fase: 'error', patrolId, mensaje: 'Las fotos existen pero no se pudieron abrir.' },
      );
    } catch {
      setAnexo({ fase: 'error', patrolId, mensaje: 'Revisa la conexión e intenta nuevamente.' });
    }
  }

  return (
    <article className="activity-card" id="informes">
      <h2 className="card-heading">Informes de ronda</h2>
      <p className="form-note">
        El PDF trae el detalle punto por punto, los que quedaron sin escanear y el anexo
        fotográfico. Se genera al momento, con los datos de ahora.
      </p>

      {rondas.length === 0 ? (
        <p className="dashboard-empty">
          Todavía no hay rondas registradas. Cuando se ejecute la primera, su informe aparecerá acá.
        </p>
      ) : (
        <ul className="informes-lista">
          {rondas.map((ronda) => {
            const abierto = anexo.fase !== 'cerrado' && anexo.patrolId === ronda.id;
            return (
              <li className="informes-fila" key={ronda.id}>
                <div className="informes-datos">
                  <strong>{ronda.siteName}</strong>
                  <span>{ronda.routeName}</span>
                  <small>
                    {fecha(ronda.scheduledStartAt)} ·{' '}
                    {ESTADO_TEXTO[ronda.status] ?? ronda.status}
                  </small>
                </div>
                <div className="informes-acciones">
                  <a
                    className="informes-descarga"
                    href={`${apiUrl}/reports/patrols/${ronda.id}`}
                    // El navegador manda la cookie HttpOnly solo; con fetch no
                    // podriamos leerla ni adjuntarla.
                    download={`informe-${ronda.id}.pdf`}
                  >
                    Descargar PDF
                  </a>
                  <button
                    className="informes-anexo-boton"
                    type="button"
                    aria-expanded={abierto}
                    onClick={() => void abrirAnexo(ronda.id)}
                  >
                    {abierto ? 'Ocultar fotos' : 'Ver fotos'}
                  </button>
                </div>

                {abierto ? (
                  <div className="informes-anexo" aria-live="polite">
                    {anexo.fase === 'cargando' ? <p>Cargando fotos…</p> : null}
                    {anexo.fase === 'vacio' ? (
                      <p className="form-note">
                        Esta ronda no exigió fotos, o todavía no se han subido.
                      </p>
                    ) : null}
                    {anexo.fase === 'error' ? (
                      <p className="guard-action-error">{anexo.mensaje}</p>
                    ) : null}
                    {anexo.fase === 'listo' ? (
                      <div className="informes-galeria">
                        {anexo.fotos.map((foto) => (
                          <figure className="informes-foto" key={foto.id}>
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img
                              alt={`Evidencia de ${foto.checkpointName ?? 'un punto de control'}`}
                              loading="lazy"
                              src={`${apiUrl}${foto.url}`}
                            />
                            <figcaption>
                              <strong>{foto.checkpointName ?? 'Punto de control'}</strong>
                              <small>
                                {fecha(foto.createdAt)} · {pesoLegible(foto.sizeBytes)}
                              </small>
                              {/* La huella corta permite cotejar contra el PDF sin
                                  mostrar 64 caracteres que nadie lee. */}
                              <code title={foto.sha256}>{foto.sha256.slice(0, 12)}…</code>
                            </figcaption>
                          </figure>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </article>
  );
}
