'use client';

import { useState } from 'react';

import { pedirApi } from './guard-outbox';

/**
 * Corregir una alerta de panico como falsa alarma (#125).
 *
 * El anti-toque baja los disparos accidentales; no los deja en cero. Sin esta
 * salida, el guardia que apreto sin querer solo puede quedarse mirando como se
 * despierta la cadena de escalamiento, y la siguiente vez va a dudar antes de
 * apretar — que es exactamente lo que no queremos que pase.
 *
 * El endpoint ya existe y es del guardia: `POST /escalation/events/:id/false-alarm`
 * con permiso `patrols:execute`, y el servidor solo lo acepta a quien reporto el
 * evento.
 *
 * IMPORTANTE, y por eso el texto lo dice: la alerta NO se borra. El libro de
 * novedades es append-only porque termina en juicios laborales; la correccion es
 * una entrada nueva que apunta a la anterior. Prometer un "deshacer" seria
 * mentir.
 */

const MINIMO_MOTIVO = 3;

export function PanicoFalsaAlarma({
  apiUrl,
  eventId,
  onCancelada,
}: {
  apiUrl: string;
  /** Id del servidor. Sin el no hay nada que corregir todavia. */
  eventId: string;
  onCancelada: () => void;
}) {
  const [abierto, setAbierto] = useState(false);
  const [motivo, setMotivo] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [error, setError] = useState<string>();

  async function enviar() {
    const texto = motivo.trim();
    if (texto.length < MINIMO_MOTIVO || enviando) return;

    setEnviando(true);
    setError(undefined);
    try {
      const respuesta = await pedirApi(apiUrl, `/escalation/events/${eventId}/false-alarm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: texto }),
      });
      if (!respuesta.ok) {
        setError('No pudimos registrar la corrección. Avisa por radio.');
        return;
      }
      setAbierto(false);
      setMotivo('');
      onCancelada();
    } catch {
      // Sin senal la correccion NO se encola: dejarla pendiente haria creer que
      // la alerta ya se desactivo mientras el supervisor sigue movilizado.
      setError('Sin señal. Avisa por radio y corrígela cuando vuelva la conexión.');
    } finally {
      setEnviando(false);
    }
  }

  if (!abierto) {
    return (
      <button
        className="guardia-boton-texto panico-falsa-abrir"
        onClick={() => setAbierto(true)}
        type="button"
      >
        Fue una falsa alarma
      </button>
    );
  }

  return (
    <div className="panico-falsa">
      <label className="guardia-campo" htmlFor="panico-falsa-motivo">
        Qué pasó
      </label>
      <textarea
        className="guardia-texto"
        id="panico-falsa-motivo"
        maxLength={2000}
        onChange={(evento) => setMotivo(evento.target.value)}
        placeholder="Ej: se activó solo en el bolsillo."
        rows={2}
        value={motivo}
      />
      <p className="guardia-nota">
        La alerta no se borra: queda anotada tu explicación al lado. Avisa igual por radio para que
        nadie siga movilizado.
      </p>

      <button
        className="guardia-boton-primario"
        disabled={enviando || motivo.trim().length < MINIMO_MOTIVO}
        onClick={() => void enviar()}
        type="button"
      >
        {enviando ? 'Enviando…' : 'Enviar corrección'}
      </button>
      <button
        className="guardia-boton-secundario ancho"
        onClick={() => {
          setAbierto(false);
          setError(undefined);
        }}
        type="button"
      >
        Volver
      </button>

      {error ? <p className="guardia-error">{error}</p> : null}
    </div>
  );
}
