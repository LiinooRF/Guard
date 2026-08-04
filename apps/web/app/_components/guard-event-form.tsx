'use client';

import { useRef, useState, type FormEvent } from 'react';

import type { Criticidad } from './guard-outbox';

/**
 * Reporte de novedades y botón de pánico (#92).
 *
 * Son EL MISMO modelo: una novedad con criticidad, y el pánico es la criticidad
 * máxima. Por eso no hay dos formularios ni dos endpoints — hay uno solo y un
 * botón aparte.
 *
 * Lo que separa al pánico del resto:
 *   - vive en su propio bloque, lejos del botón de enviar, para que no se pulse
 *     por error mientras se escribe una novedad;
 *   - exige una confirmación deliberada, con la mano ya en la pantalla;
 *   - NO pide texto. Quien aprieta ese botón no está en condiciones de escribir.
 *
 * El libro de novedades es append-only: lo que se manda no se edita ni se borra,
 * porque termina en juicios laborales y un registro editable no sirve de prueba.
 * Una corrección es otra entrada que apunta a la anterior.
 */

const CRITICIDADES: ReadonlyArray<{ valor: Criticidad; etiqueta: string; ayuda: string }> = [
  { valor: 'info', etiqueta: 'Informativa', ayuda: 'Queda en el libro, nadie se mueve' },
  { valor: 'baja', etiqueta: 'Baja', ayuda: 'Sin riesgo inmediato' },
  { valor: 'media', etiqueta: 'Media', ayuda: 'El supervisor debe enterarse' },
  { valor: 'alta', etiqueta: 'Alta', ayuda: 'Requiere respuesta ahora' },
];

export function GuardEventForm({
  enviando,
  mensaje,
  onReportar,
  onPanico,
}: {
  enviando: boolean;
  mensaje?: string;
  onReportar: (entrada: { criticidad: Criticidad; texto: string; foto?: File }) => void;
  onPanico: () => void;
}) {
  const [criticidad, setCriticidad] = useState<Criticidad>('media');
  const [texto, setTexto] = useState('');
  const [foto, setFoto] = useState<File>();
  const [confirmandoPanico, setConfirmandoPanico] = useState(false);
  const campoFoto = useRef<HTMLInputElement>(null);

  function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    if (enviando || !texto.trim()) return;
    onReportar({ criticidad, texto: texto.trim(), ...(foto ? { foto } : {}) });
    setTexto('');
    quitarFoto();
  }

  function quitarFoto() {
    setFoto(undefined);
    if (campoFoto.current) campoFoto.current.value = '';
  }

  return (
    <section className="guardia-novedades" aria-labelledby="guardia-novedades-titulo">
      <h2 id="guardia-novedades-titulo">Reportar novedad</h2>

      <form className="guardia-formulario" onSubmit={enviar}>
        <fieldset className="guardia-criticidad">
          <legend>Criticidad</legend>
          {CRITICIDADES.map((opcion) => (
            <label
              className={`guardia-opcion${criticidad === opcion.valor ? ' elegida' : ''}`}
              key={opcion.valor}
            >
              <input
                checked={criticidad === opcion.valor}
                name="criticidad"
                onChange={() => setCriticidad(opcion.valor)}
                type="radio"
                value={opcion.valor}
              />
              <strong>{opcion.etiqueta}</strong>
              <small>{opcion.ayuda}</small>
            </label>
          ))}
        </fieldset>

        <label className="guardia-campo" htmlFor="guardia-texto">
          Qué pasó
        </label>
        <textarea
          className="guardia-texto"
          id="guardia-texto"
          maxLength={2000}
          minLength={3}
          onChange={(evento) => setTexto(evento.target.value)}
          placeholder="Describe lo que viste, dónde y a qué hora."
          required
          rows={4}
          value={texto}
        />

        {/*
          Solo cámara: `capture` abre la cámara y no el selector de archivos. Si
          se pudiera elegir de la galería, el guardia fotografía la puerta cerrada
          una vez y reusa esa imagen todo el mes; la evidencia deja de valer.
        */}
        <div className="guardia-foto">
          <label className="guardia-boton-secundario ancho" htmlFor="guardia-foto-campo">
            {foto ? 'Repetir foto' : 'Tomar foto'}
          </label>
          <input
            accept="image/*"
            capture="environment"
            className="guardia-invisible"
            id="guardia-foto-campo"
            onChange={(evento) => setFoto(evento.target.files?.[0])}
            ref={campoFoto}
            type="file"
          />
          {foto ? (
            <p className="guardia-nota">
              Foto tomada. Se sube al recuperar señal; si cierras la app antes, se pierde.{' '}
              <button className="guardia-boton-texto" onClick={quitarFoto} type="button">
                Quitar
              </button>
            </p>
          ) : null}
        </div>

        <button className="guardia-boton-primario" disabled={enviando || !texto.trim()} type="submit">
          {enviando ? 'Registrando…' : 'Registrar novedad'}
        </button>
      </form>

      {mensaje ? (
        <p className="guardia-anuncio" role="status" aria-live="polite">
          {mensaje}
        </p>
      ) : null}

      <div className="guardia-panico">
        <h3>Emergencia</h3>
        {confirmandoPanico ? (
          <>
            <p className="guardia-panico-pregunta">
              ¿Confirmas la alerta de pánico? Se avisa de inmediato y queda registrada.
            </p>
            <button
              className="guardia-boton-panico"
              onClick={() => {
                setConfirmandoPanico(false);
                onPanico();
              }}
              type="button"
            >
              Sí, enviar alerta
            </button>
            <button
              className="guardia-boton-secundario ancho"
              onClick={() => setConfirmandoPanico(false)}
              type="button"
            >
              Cancelar
            </button>
          </>
        ) : (
          <>
            <button
              className="guardia-boton-panico"
              onClick={() => setConfirmandoPanico(true)}
              type="button"
            >
              PÁNICO
            </button>
            <p className="guardia-nota">No pide texto. Pide una confirmación y se envía.</p>
          </>
        )}
      </div>
    </section>
  );
}
