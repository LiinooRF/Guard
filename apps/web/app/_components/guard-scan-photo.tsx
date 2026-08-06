'use client';

import { useRef, useState } from 'react';

/**
 * La foto obligatoria del punto de control.
 *
 * En los accesos críticos el guardia no solo marca la etiqueta: además tiene
 * que fotografiar el estado de la puerta. Eso es lo que el cliente final mira
 * cuando algo pasa, y hasta ahora la pantalla de terreno no se lo pedía nunca —
 * ni siquiera sabía qué puntos lo exigían.
 *
 * Aparece DESPUÉS de registrar el punto, no antes, por dos razones: la marca es
 * lo que no se puede perder y va primero, y la foto necesita el id del escaneo
 * para colgarse de él.
 *
 * Tres reglas que no se negocian acá:
 *
 *  1. **Solo cámara.** `capture="environment"` abre la cámara y no el selector
 *     de archivos. Si se pudiera elegir de la galería, el guardia fotografía la
 *     puerta cerrada una vez y reusa esa imagen todo el mes: la evidencia deja
 *     de valer. No existe ninguna otra ruta en esta interfaz para adjuntar un
 *     archivo.
 *  2. **No bloquea la ronda.** Una cámara que no abre no puede dejar a un
 *     guardia encerrado en un punto a las 3 de la mañana. Se puede seguir, pero
 *     el punto queda marcado «Falta la foto» en la lista, en el resumen y en el
 *     conteo de lo que falta subir: la deuda se ve, no se perdona.
 *  3. **La foto no se pierde.** Se guarda en el almacén persistente antes de
 *     intentar subirla, así que sobrevive a que se cierre el WebView y se sube
 *     sola al recuperar señal.
 */
export function GuardScanPhoto({
  nombrePunto,
  esperando,
  aviso,
  guardadaSinSubir = false,
  onFoto,
  onPostergar,
}: {
  nombrePunto: string;
  /** `true` mientras se procesa y guarda la foto recién tomada. */
  esperando: boolean;
  aviso?: string;
  /**
   * La foto ya está a salvo en el teléfono pero el servidor todavía no la tiene.
   * Con esto en `true` el panel deja de hablar de una foto que falta —no falta,
   * la tomó— y pasa a hablar de una que está en camino.
   */
  guardadaSinSubir?: boolean;
  onFoto: (foto: File) => void;
  onPostergar: () => void;
}) {
  const campo = useRef<HTMLInputElement>(null);
  const [tomada, setTomada] = useState(false);

  return (
    <section className="guardia-foto-punto" aria-labelledby="guardia-foto-punto-titulo">
      <h2 id="guardia-foto-punto-titulo">Fotografía el punto</h2>
      <p className="guardia-nota">
        <strong>{nombrePunto}</strong> exige foto. Encuadra el estado de la puerta o del acceso,
        completo y legible.
      </p>

      <div className="guardia-foto">
        <label className="guardia-boton-primario ancho" htmlFor="guardia-foto-punto-campo">
          {esperando ? 'Guardando la foto…' : tomada ? 'Repetir foto' : 'Tomar foto'}
        </label>
        <input
          accept="image/*"
          capture="environment"
          className="guardia-invisible"
          disabled={esperando}
          id="guardia-foto-punto-campo"
          onChange={(evento) => {
            const archivo = evento.target.files?.[0];
            if (!archivo) return;
            setTomada(true);
            onFoto(archivo);
            // Se limpia para que volver a elegir la MISMA imagen dispare el
            // change: sin esto, repetir la foto tras un fallo no hacía nada.
            if (campo.current) campo.current.value = '';
          }}
          ref={campo}
          type="file"
        />
      </div>

      {aviso ? (
        <p className="guardia-anuncio" role="status" aria-live="polite">
          {aviso}
        </p>
      ) : null}

      <button
        className="guardia-boton-texto"
        disabled={esperando}
        onClick={onPostergar}
        type="button"
      >
        {guardadaSinSubir ? 'Seguir con la ronda' : 'No puedo tomarla ahora'}
      </button>
      <p className="guardia-nota">
        {guardadaSinSubir
          ? 'La foto está guardada en el teléfono y se envía sola cuando haya señal. Puedes seguir la ronda.'
          : 'Si sigues sin foto, el punto queda marcado como pendiente de evidencia y tu supervisor lo ve en el informe.'}
      </p>
    </section>
  );
}
