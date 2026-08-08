'use client';

/**
 * Pantalla de consentimiento de geolocalizacion (#78).
 *
 * Es lo primero que ve el trabajador cuando la empresa tiene el rastreo activo y
 * el todavia no acepto el texto vigente. No es un formalismo administrativo: sin
 * esta aceptacion el servidor rechaza la traza con 403, asi que la pantalla es
 * la condicion para que la funcion opere.
 *
 * Tres decisiones que no son de estilo:
 *
 *  - El TEXTO viene del servidor (GET /consent/policy). Nunca se escribe aca:
 *    si el aviso viviera en el bundle, dos empresas del mismo SaaS mostrarian el
 *    mismo texto y una version desplegada hoy invalidaria las aceptaciones de
 *    ayer sin que nadie se enterara.
 *  - Los numeros del aviso (cada cuanto se registra la posicion, cuantos dias se
 *    conserva) tambien vienen del servidor: son reglas del tenant.
 *  - "Rechazar" y "Retirar mi consentimiento" existen siempre y estan a la vista.
 *    Un consentimiento que no se puede retirar no es consentimiento.
 */
import { useState } from 'react';

import { EVENTO_CONSENTIMIENTO_ACEPTADO } from './guard-permiso-ubicacion';

export interface AvisoConsentimiento {
  hasPolicy: boolean;
  policy: {
    version: string;
    body: string;
    privacyPolicyUrl: string;
    publishedAt: string;
  } | null;
  acceptance: {
    status: 'vigente' | 'desactualizado' | 'revocado' | 'nunca_aceptado';
    acceptedVersion: string | null;
    grantedAt: string | null;
    revokedAt: string | null;
    deviceInfo: string | null;
  };
  tracking: {
    enabled: boolean;
    sampleIntervalSeconds: number;
    retentionDays: number;
  };
  actionRequired: 'ninguna' | 'aceptar' | 'reaceptar' | 'publicar_aviso';
}

type Tono = 'ok' | 'error';

export function ConsentimientoAviso({
  aviso,
  apiUrl,
  onCambio,
}: {
  aviso: AvisoConsentimiento;
  apiUrl: string;
  /** El contenedor recarga el estado desde el servidor; aca no se adivina. */
  onCambio?: () => void;
}) {
  const [enviando, setEnviando] = useState(false);
  const [mensaje, setMensaje] = useState<{ tono: Tono; texto: string } | null>(null);

  async function aceptar() {
    if (!aviso.policy) return;
    setEnviando(true);
    setMensaje(null);
    try {
      const respuesta = await fetch(`${apiUrl}/geo/consent`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // La version la manda el servidor en el aviso: la interfaz no la
          // inventa ni la recuerda de una carga anterior.
          policyVersion: aviso.policy.version,
          deviceInfo: equipoAproximado(),
        }),
      });
      if (!respuesta.ok) {
        setMensaje({ tono: 'error', texto: await mensajeDeError(respuesta) });
        return;
      }
      setMensaje({ tono: 'ok', texto: 'Listo. Quedó registrada tu aceptación con fecha y hora.' });
      /*
       * Aviso al puente (#275): con la divulgación destacada recién aceptada,
       * ESTE es el momento en que la app puede pedir el permiso de ubicación
       * del sistema y reportar cómo quedó. Lo escucha `use-guard-bridge`; en el
       * navegador de escritorio no lo escucha nadie y no pasa nada, que es
       * exactamente lo que corresponde sin teléfono.
       */
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(EVENTO_CONSENTIMIENTO_ACEPTADO));
      }
      onCambio?.();
    } catch {
      setMensaje({
        tono: 'error',
        texto: 'No pudimos registrar tu respuesta. Revisa la conexión e inténtalo de nuevo.',
      });
    } finally {
      setEnviando(false);
    }
  }

  async function revocar() {
    setEnviando(true);
    setMensaje(null);
    try {
      const respuesta = await fetch(`${apiUrl}/geo/consent`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!respuesta.ok) {
        setMensaje({ tono: 'error', texto: await mensajeDeError(respuesta) });
        return;
      }
      setMensaje({
        tono: 'ok',
        texto:
          'Retiraste tu consentimiento. Desde ahora no se registra tu recorrido. Los recorridos ya guardados se conservan hasta que venza su plazo.',
      });
      onCambio?.();
    } catch {
      setMensaje({
        tono: 'error',
        texto: 'No pudimos registrar tu respuesta. Revisa la conexión e inténtalo de nuevo.',
      });
    } finally {
      setEnviando(false);
    }
  }

  if (!aviso.hasPolicy || !aviso.policy) {
    return (
      <section className="management-card management-wide" id="consentimiento">
        <div className="card-heading">
          <div>
            <span className="eyebrow">Ubicación</span>
            <h2>Aviso de geolocalización</h2>
          </div>
        </div>
        <div className="dashboard-empty">
          <strong>Tu empresa todavía no publicó el aviso</strong>
          <span>
            Mientras no exista, no se te puede pedir consentimiento y no se registra tu recorrido.
            Avisa a tu administrador.
          </span>
        </div>
      </section>
    );
  }

  const vigente = aviso.acceptance.status === 'vigente';
  const debeReaceptar = aviso.acceptance.status === 'desactualizado';

  return (
    <section className="management-card management-wide" id="consentimiento">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Ubicación</span>
          <h2>Aviso de geolocalización</h2>
        </div>
        <span className={`state-chip ${vigente ? 'active' : ''}`}>{ETIQUETA[aviso.acceptance.status]}</span>
      </div>

      <p className="section-explanation">
        Tu ubicación se registra <strong>solo mientras tu ronda está en curso</strong>. Fuera del
        turno el sistema no acepta posiciones: no es una promesa de la aplicación, el servidor las
        rechaza.
      </p>

      {!aviso.tracking.enabled ? (
        <p className="form-note">
          Hoy tu empresa tiene desactivado el registro de recorrido, así que no se está guardando
          ninguna posición. Igual puedes dejar registrada tu respuesta.
        </p>
      ) : null}

      <ul className="management-list">
        <li className="management-row">
          <div>
            <strong>Cada cuánto</strong>
            <small>Una posición cada {aviso.tracking.sampleIntervalSeconds} segundos durante la ronda.</small>
          </div>
        </li>
        <li className="management-row">
          <div>
            <strong>Por cuánto tiempo</strong>
            <small>El recorrido se guarda {aviso.tracking.retentionDays} días y después se elimina.</small>
          </div>
        </li>
        <li className="management-row">
          <div>
            <strong>Para qué</strong>
            <small>
              Verificar que la ronda se hizo en terreno y poder auxiliarte si ocurre una emergencia.
            </small>
          </div>
        </li>
      </ul>

      {/* El texto de la empresa, tal cual se publicó. Se respetan los saltos de
          linea con pre-wrap en vez de interpretar HTML: nada de lo que escribe
          un admin se renderiza como marcado. */}
      <p className="section-explanation" style={{ whiteSpace: 'pre-wrap' }}>
        {aviso.policy.body}
      </p>

      <p className="form-note">
        Versión {aviso.policy.version} · publicada el {formatearFecha(aviso.policy.publishedAt)} ·{' '}
        <a href={aviso.policy.privacyPolicyUrl} target="_blank" rel="noreferrer noopener">
          Política de privacidad
        </a>
      </p>

      {debeReaceptar ? (
        <p className="management-message" role="status">
          Tu empresa actualizó el aviso
          {aviso.acceptance.acceptedVersion
            ? ` (aceptaste la versión ${aviso.acceptance.acceptedVersion})`
            : ''}
          . Léelo y vuelve a aceptarlo para seguir trabajando con el recorrido activo.
        </p>
      ) : null}

      {vigente && aviso.acceptance.grantedAt ? (
        <p className="form-note">
          Aceptaste este aviso el {formatearFecha(aviso.acceptance.grantedAt)}.
        </p>
      ) : null}

      {mensaje ? (
        <p className="management-message" role="status">
          {mensaje.texto}
        </p>
      ) : null}

      <div className="row-actions">
        {!vigente ? (
          <button type="button" className="primary-button" disabled={enviando} onClick={aceptar}>
            {enviando ? 'Registrando…' : debeReaceptar ? 'Acepto el aviso actualizado' : 'Acepto'}
          </button>
        ) : null}
        <button
          type="button"
          className="secondary-button danger-button"
          disabled={enviando}
          onClick={revocar}
        >
          {vigente ? 'Retirar mi consentimiento' : 'No acepto'}
        </button>
      </div>

      <p className="form-note">
        Puedes retirar tu consentimiento cuando quieras y sin dar explicaciones. Si lo retiras, deja
        de registrarse tu recorrido de inmediato.
      </p>
    </section>
  );
}

const ETIQUETA: Record<AvisoConsentimiento['acceptance']['status'], string> = {
  vigente: 'Aceptado',
  desactualizado: 'Aviso actualizado',
  revocado: 'Retirado',
  nunca_aceptado: 'Pendiente',
};

/**
 * Marca aproximada del equipo, sin nada que identifique a la persona ni al chip.
 * Dentro de la app la capa nativa puede mandar el modelo exacto; desde el
 * navegador esto es lo unico honesto que se puede decir.
 */
function equipoAproximado(): string {
  if (typeof navigator === 'undefined') return 'Equipo sin identificar';
  const ua = navigator.userAgent;
  if (/android/i.test(ua)) return 'Android';
  if (/iphone|ipad/i.test(ua)) return 'iPhone o iPad';
  if (/windows/i.test(ua)) return 'Computador Windows';
  if (/mac os/i.test(ua)) return 'Computador Mac';
  return 'Equipo sin identificar';
}

function formatearFecha(valor: string) {
  return new Intl.DateTimeFormat('es-CL', { dateStyle: 'long', timeStyle: 'short' }).format(
    new Date(valor),
  );
}

export async function mensajeDeError(respuesta: Response): Promise<string> {
  try {
    const datos = (await respuesta.json()) as { message?: string | string[] };
    if (Array.isArray(datos.message)) return datos.message.join('. ');
    if (datos.message) return datos.message;
  } catch {
    // Sin cuerpo util: se responde con el texto generico de abajo.
  }
  if (respuesta.status === 403) return 'Tu cuenta no puede hacer esta operación.';
  if (respuesta.status === 404) return 'Eso ya no está disponible.';
  return 'No fue posible completar la operación.';
}
