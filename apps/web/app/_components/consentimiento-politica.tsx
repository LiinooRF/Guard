'use client';

/**
 * Publicacion del aviso de geolocalizacion — panel del ADMIN (#78).
 *
 * Lo que se publica aca es lo que el trabajador lee y acepta, y lo que se le
 * muestra a un fiscalizador si pregunta que se informo. Por eso:
 *
 *  - Un texto publicado NO se edita. Se publica una version nueva y la anterior
 *    queda en el historial. Editar "la v2" despues de que 40 personas la
 *    aceptaron dejaria la aceptacion sin respaldo.
 *  - Publicar una version nueva puede dejar a toda la operacion pendiente de
 *    re-aceptar. El servidor devuelve a cuanta gente afecto y se muestra sin
 *    adornos: es informacion operativa, no una advertencia decorativa.
 *  - Los limites del texto NO se repiten aca. Los valida el servidor y se
 *    muestra su mensaje; duplicarlos en el navegador es garantizar que un dia
 *    digan cosas distintas.
 */
import { useState } from 'react';

import { mensajeDeError } from './consentimiento-aviso';

export interface VersionAviso {
  id: string;
  version: string;
  privacyPolicyUrl: string;
  publishedAt: string;
  retiredAt: string | null;
  publishedBy: string | null;
  acceptances: number;
  activeAcceptances: number;
  isCurrent: boolean;
}

interface Aviso {
  tono: 'ok' | 'error';
  texto: string;
}

export function ConsentimientoPolitica({
  historialInicial,
  versionVigente,
  apiUrl,
}: {
  historialInicial: VersionAviso[];
  versionVigente: string | null;
  apiUrl: string;
}) {
  const [historial, setHistorial] = useState(historialInicial);
  const [version, setVersion] = useState('');
  const [texto, setTexto] = useState('');
  const [url, setUrl] = useState(historialInicial[0]?.privacyPolicyUrl ?? '');
  const [abierto, setAbierto] = useState(historialInicial.length === 0);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<Aviso | null>(null);

  async function publicar() {
    setGuardando(true);
    setAviso(null);
    try {
      const respuesta = await fetch(`${apiUrl}/consent/policies`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          version: version.trim(),
          body: texto,
          privacyPolicyUrl: url.trim(),
        }),
      });
      if (!respuesta.ok) {
        setAviso({ tono: 'error', texto: await mensajeDeError(respuesta) });
        return;
      }
      const creada = (await respuesta.json()) as {
        version: string;
        pendingReacceptance: number;
        reacceptanceEnforced: boolean;
      };
      setAviso({ tono: 'ok', texto: resumenDePublicacion(creada) });
      setVersion('');
      setTexto('');
      setAbierto(false);
      await recargarHistorial();
    } catch {
      setAviso({ tono: 'error', texto: 'No pudimos publicar. Revisa la conexión y reintenta.' });
    } finally {
      setGuardando(false);
    }
  }

  async function recargarHistorial() {
    try {
      const respuesta = await fetch(`${apiUrl}/consent/policies`, { credentials: 'include' });
      if (!respuesta.ok) return;
      setHistorial((await respuesta.json()) as VersionAviso[]);
    } catch {
      // El aviso ya se publico: no poder refrescar la lista no es un fallo de la
      // operacion, y borrar lo que se ve seria peor que dejarlo desactualizado.
    }
  }

  const listo = version.trim().length > 0 && texto.trim().length > 0 && url.trim().length > 0;

  return (
    <section className="management-card management-wide" id="aviso-geolocalizacion">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Cumplimiento legal</span>
          <h2>Aviso de geolocalización</h2>
        </div>
        <button
          type="button"
          className="secondary-button"
          disabled={guardando}
          onClick={() => setAbierto((previo) => !previo)}
        >
          {abierto ? 'Cerrar' : 'Publicar versión nueva'}
        </button>
      </div>

      <p className="section-explanation">
        Es el texto que el trabajador lee y acepta antes de que se registre su recorrido. Registrar
        la ubicación de un trabajador exige aviso previo, así que sin este texto publicado las
        aceptaciones no acreditan nada.
      </p>

      {!versionVigente ? (
        <div className="dashboard-empty">
          <strong>Todavía no hay un aviso publicado</strong>
          <span>
            Mientras no exista, nadie puede aceptar y no se acumula recorrido. Publica la primera
            versión para dejar el rastreo en regla.
          </span>
        </div>
      ) : null}

      {aviso ? (
        <p className="management-message" role="status">
          {aviso.texto}
        </p>
      ) : null}

      {abierto ? (
        <div className="management-form">
          <label>
            <span>Nombre de la versión</span>
            <input
              value={version}
              disabled={guardando}
              placeholder="2026-v1"
              onChange={(evento) => setVersion(evento.target.value)}
            />
          </label>
          <label>
            <span>Política de privacidad (dirección pública https)</span>
            <input
              value={url}
              disabled={guardando}
              placeholder="https://tuempresa.cl/privacidad"
              onChange={(evento) => setUrl(evento.target.value)}
            />
          </label>
          <label className="management-wide">
            <span>Texto del aviso</span>
            <textarea
              value={texto}
              rows={12}
              disabled={guardando}
              placeholder={PLANTILLA}
              onChange={(evento) => setTexto(evento.target.value)}
            />
          </label>
          <p className="form-note">
            Tiene que decir qué se registra, cuándo, para qué y por cuánto tiempo se conserva. Una
            vez publicado no se edita: si hay que corregirlo, se publica otra versión y esta queda en
            el historial.
          </p>
          <p className="form-note">
            Al publicar, quienes habían aceptado una versión anterior quedan pendientes de aceptar la
            nueva y su recorrido deja de registrarse hasta que lo hagan.
          </p>
          <button
            type="button"
            className="primary-button"
            disabled={!listo || guardando}
            onClick={publicar}
          >
            {guardando ? 'Publicando…' : 'Publicar aviso'}
          </button>
        </div>
      ) : null}

      <div className="management-list">
        {historial.map((entrada) => (
          <article className="management-row" key={entrada.id}>
            <div>
              <strong>Versión {entrada.version}</strong>
              <small>
                Publicada el {formatearFecha(entrada.publishedAt)}
                {entrada.publishedBy ? ` por ${entrada.publishedBy}` : ''}
              </small>
              <small>
                {entrada.activeAcceptances} de {entrada.acceptances} aceptaciones siguen vigentes
              </small>
            </div>
            <span className={`state-chip ${entrada.isCurrent ? 'active' : ''}`}>
              {entrada.isCurrent
                ? 'Vigente'
                : `Retirada${entrada.retiredAt ? ` el ${formatearFecha(entrada.retiredAt)}` : ''}`}
            </span>
            <a
              className="secondary-button"
              href={entrada.privacyPolicyUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Política de privacidad
            </a>
          </article>
        ))}
        {!historial.length ? (
          <div className="dashboard-empty">
            <strong>Sin versiones publicadas</strong>
            <span>El historial guarda cada texto y su fecha, aunque después se reemplace.</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function resumenDePublicacion(creada: {
  version: string;
  pendingReacceptance: number;
  reacceptanceEnforced: boolean;
}) {
  if (!creada.reacceptanceEnforced) {
    return `Aviso ${creada.version} publicado. Las aceptaciones anteriores siguen vigentes porque la re-aceptación está desactivada en la configuración de reglas.`;
  }
  if (creada.pendingReacceptance === 0) {
    return `Aviso ${creada.version} publicado. No había aceptaciones anteriores que cerrar.`;
  }
  const gente =
    creada.pendingReacceptance === 1
      ? '1 persona queda pendiente'
      : `${creada.pendingReacceptance} personas quedan pendientes`;
  return `Aviso ${creada.version} publicado. ${gente} de aceptar el texto nuevo; hasta que lo hagan no se registra su recorrido.`;
}

function formatearFecha(valor: string) {
  return new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium' }).format(new Date(valor));
}

const PLANTILLA = `Durante tu turno, y solo mientras tu ronda está en curso, la aplicación registra tu ubicación para verificar que los puntos de control se marcaron en terreno y para poder auxiliarte ante una emergencia.

No se registra tu ubicación fuera del turno. No se guarda tu número de teléfono ni el identificador de tu equipo.

Puedes retirar tu consentimiento en cualquier momento desde la misma aplicación.`;
