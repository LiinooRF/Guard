'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as EventoTeclado, PointerEvent as EventoPuntero } from 'react';

/**
 * Boton de panico con anti-toque (#125).
 *
 * El problema real: el telefono vive en el bolsillo de un uniforme durante ocho
 * horas. Un boton que dispara con un toque dispara solo, y una alerta de panico
 * falsa a las 3 de la manana quema la confianza del cliente en el sistema
 * completo. El anti-toque no es adorno; es lo que hace usable la funcion.
 *
 * Lo que exige para disparar, en orden:
 *
 *   1. Mantener presionado N segundos seguidos. N lo configura la empresa
 *      (`panicHoldSeconds`); aca no se decide.
 *   2. Que la pantalla este encendida y el portal al frente. En el bolsillo la
 *      pantalla esta apagada y `visibilityState` no es 'visible': ni siquiera
 *      empieza a contar, y si se bloquea a mitad del gesto se aborta.
 *   3. Un solo dedo. Un segundo contacto (palma, tela, bolsillo) aborta.
 *   4. Que el dedo no se corra mas de la tolerancia: un toque que se arrastra es
 *      un roce, no una decision.
 *   5. Eventos de verdad. Un evento sintetico (`isTrusted === false`) se ignora.
 *
 * SILENCIO: al completarse NO suena, NO vibra y esta pantalla no cambia. La
 * unica senal es la linea de estado, que se lee igual que "quedan 3 sin subir".
 * Si el guardia esta frente a un asaltante, una alarma que suena lo pone en
 * riesgo. Por eso este archivo no llama a `navigator.vibrate` ni reproduce nada,
 * y por eso el gesto se muestra con marcas neutras y no con un contador rojo.
 */

/**
 * Piso de seguridad, no una regla de negocio: con 0 segundos el boton
 * dispararia con un roce. Espeja el minimo declarado para `panicHoldSeconds`.
 */
const SEGUNDOS_MINIMOS = 1;

/** Cada cuanto se revisa el gesto sostenido. Solo corre mientras hay un dedo apoyado. */
const TICK_MS = 100;

/**
 * Cuanto puede correrse el dedo sin abortar, en pixeles CSS. Generoso a
 * proposito: la mano de alguien asustado tiembla, y el gesto se hace muchas
 * veces sin mirar la pantalla.
 */
const TOLERANCIA_ARRASTRE_PX = 96;

export function PanicoBoton({
  segundosMantener,
  onDisparar,
  deshabilitado = false,
  etiqueta = 'PÁNICO',
}: {
  /** Segundos que hay que sostener. Viene de las reglas de la empresa. */
  segundosMantener: number;
  onDisparar: () => void;
  deshabilitado?: boolean;
  etiqueta?: string;
}) {
  // Un valor no numerico (configuracion rota, respuesta rara) no puede dejar el
  // boton muerto ni disparandose solo: cae al piso de seguridad.
  const objetivo = Number.isFinite(segundosMantener)
    ? Math.max(Math.round(segundosMantener), SEGUNDOS_MINIMOS)
    : SEGUNDOS_MINIMOS;
  const [sostenidos, setSostenidos] = useState(0);

  const punteroRef = useRef<number | null>(null);
  const origenRef = useRef<{ x: number; y: number; desdeMs: number } | null>(null);
  const relojRef = useRef<number | null>(null);

  const abortar = useCallback(() => {
    if (relojRef.current !== null) {
      window.clearInterval(relojRef.current);
      relojRef.current = null;
    }
    punteroRef.current = null;
    origenRef.current = null;
    setSostenidos(0);
  }, []);

  // Pantalla bloqueada o app al fondo a mitad del gesto: el dedo puede seguir
  // apoyado dentro del bolsillo, asi que el gesto se cae.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    const alCambiar = () => {
      if (document.visibilityState !== 'visible') abortar();
    };
    document.addEventListener('visibilitychange', alCambiar);
    window.addEventListener('blur', abortar);
    return () => {
      document.removeEventListener('visibilitychange', alCambiar);
      window.removeEventListener('blur', abortar);
    };
  }, [abortar]);

  // Desmontar con un gesto a medias dejaria un intervalo vivo.
  useEffect(() => abortar, [abortar]);

  useEffect(() => {
    if (deshabilitado) abortar();
  }, [abortar, deshabilitado]);

  const comenzar = useCallback(
    (origen: { x: number; y: number }) => {
      if (deshabilitado || relojRef.current !== null) return;
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;

      const desdeMs = Date.now();
      origenRef.current = { ...origen, desdeMs };
      setSostenidos(0);

      relojRef.current = window.setInterval(() => {
        const inicio = origenRef.current;
        if (inicio === null) return;
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
          abortar();
          return;
        }

        const transcurridoMs = Date.now() - inicio.desdeMs;
        const completos = Math.min(Math.floor(transcurridoMs / 1000), objetivo);
        setSostenidos((actual) => (actual === completos ? actual : completos));

        if (transcurridoMs >= objetivo * 1000) {
          // Primero se apaga el gesto y despues se avisa: asi la pantalla queda
          // exactamente como estaba y nada delata que la alerta salio.
          abortar();
          onDisparar();
        }
      }, TICK_MS);
    },
    [abortar, deshabilitado, objetivo, onDisparar],
  );

  function alPresionar(evento: EventoPuntero<HTMLButtonElement>) {
    if (!evento.isTrusted) return;
    if (evento.pointerType === 'mouse' && evento.button !== 0) return;
    // Ya habia un dedo apoyado: dos contactos es bolsillo o palma, no una decision.
    if (punteroRef.current !== null) {
      abortar();
      return;
    }
    if (deshabilitado) return;
    // Pantalla apagada o portal al fondo: ni siquiera empieza a contar.
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    try {
      evento.currentTarget.setPointerCapture(evento.pointerId);
    } catch {
      // Sin captura el gesto igual funciona; solo se pierde el seguimiento fuera
      // del boton, que ya aborta por otros caminos.
    }
    punteroRef.current = evento.pointerId;
    comenzar({ x: evento.clientX, y: evento.clientY });
  }

  function alMover(evento: EventoPuntero<HTMLButtonElement>) {
    if (punteroRef.current !== evento.pointerId) return;
    const inicio = origenRef.current;
    if (inicio === null) return;
    const dx = evento.clientX - inicio.x;
    const dy = evento.clientY - inicio.y;
    if (dx * dx + dy * dy > TOLERANCIA_ARRASTRE_PX * TOLERANCIA_ARRASTRE_PX) abortar();
  }

  function alSoltar(evento: EventoPuntero<HTMLButtonElement>) {
    if (punteroRef.current !== evento.pointerId) return;
    abortar();
  }

  /**
   * Teclado, para el mismo portal abierto en un escritorio. La barra y Enter
   * activarian el boton al toque: se les quita el default y se exige sostener,
   * igual que con el dedo.
   */
  function alBajarTecla(evento: EventoTeclado<HTMLButtonElement>) {
    if (evento.key !== ' ' && evento.key !== 'Enter') return;
    evento.preventDefault();
    if (evento.repeat) return;
    comenzar({ x: 0, y: 0 });
  }

  function alSubirTecla(evento: EventoTeclado<HTMLButtonElement>) {
    if (evento.key !== ' ' && evento.key !== 'Enter') return;
    abortar();
  }

  const marcas = Array.from({ length: objetivo }, (_, indice) => indice);

  return (
    <>
      <button
        aria-describedby="panico-boton-ayuda"
        className={`guardia-boton-panico panico-boton${sostenidos > 0 ? ' sosteniendo' : ''}`}
        disabled={deshabilitado}
        onContextMenu={(evento) => evento.preventDefault()}
        onKeyDown={alBajarTecla}
        onKeyUp={alSubirTecla}
        onLostPointerCapture={alSoltar}
        onPointerCancel={alSoltar}
        onPointerDown={alPresionar}
        onPointerMove={alMover}
        onPointerUp={alSoltar}
        type="button"
      >
        {etiqueta}
        <span aria-hidden="true" className="panico-marcas">
          {marcas.map((indice) => (
            <span
              className={`panico-marca${indice < sostenidos ? ' llena' : ''}`}
              key={indice}
            />
          ))}
        </span>
      </button>

      <p className="guardia-nota" id="panico-boton-ayuda">
        Mantén el dedo apretado {objetivo} segundo{objetivo === 1 ? '' : 's'} sin soltar. No suena
        ni vibra: nadie a tu lado se entera.
      </p>
    </>
  );
}
