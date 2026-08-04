'use client';

import { useEffect, useRef, useState } from 'react';

import { sincronizar, suscribirCola, type EstadoCola } from './guard-outbox';
import { useReglasSync, type ReglasSync } from './sync-reglas';

/**
 * Cierre de turno con trabajo sin subir (#74).
 *
 * Envuelve el boton de "marcar salida" y mete una advertencia clara en el
 * unico momento en que todavia se puede hacer algo: antes de que el guardia
 * apague el telefono y se vaya del recinto.
 *
 * Por que un aviso pasivo no alcanzaba: la version anterior mostraba un parrafo
 * DESPUES del boton, asi que el guardia marcaba salida y se iba sin leerlo. Aca
 * la advertencia se ve antes de tocar nada, y —si la empresa lo configura asi—
 * terminar exige una segunda confirmacion explicita.
 *
 * Lo que este componente NO hace: llamar a `POST /guard/shift/end`. Eso lo
 * sigue haciendo el padre en `onConfirmar`, que es quien sabe que hacer despues
 * (olvidar el estado de la ronda, refrescar). Aca solo se decide CUANDO se
 * puede llamar.
 */

const COLA_VACIA: EstadoCola = { pendientes: 0, rechazadas: [], sincronizando: false };

export interface SyncAvisoCierreProps {
  apiUrl: string;
  /** Marca la salida de jornada. Se llama solo cuando ya se puede terminar. */
  onConfirmar: () => void;
  /** El padre esta esperando la respuesta del servidor. */
  marcando?: boolean;
  /**
   * Trabajo de la ronda que el estado local todavia no da por confirmado
   * (`hayPendientesDeSubir(estado)`). Es una segunda fuente sobre la cola: una
   * foto de novedad sin subir no aparece en la cola de operaciones.
   */
  pendientesRonda?: boolean;
  /** Reglas ya resueltas por el padre. Si no vienen, las pide este componente. */
  reglas?: ReglasSync;
  /** Recinto de la ronda, para resolver las reglas al nivel correcto de la cascada. */
  siteId?: string;
  etiqueta?: string;
  /** Resultado de la marcacion, redactado por el padre. */
  mensaje?: string;
}

export function SyncAvisoCierre({
  apiUrl,
  onConfirmar,
  marcando = false,
  pendientesRonda = false,
  reglas,
  siteId,
  etiqueta = 'Marcar salida de jornada',
  mensaje,
}: SyncAvisoCierreProps) {
  const [cola, setCola] = useState<EstadoCola>(COLA_VACIA);
  const [confirmando, setConfirmando] = useState(false);
  const [subioTodo, setSubioTodo] = useState(false);
  const [avisoAccion, setAvisoAccion] = useState<string>();
  const tituloConfirmacion = useRef<HTMLHeadingElement>(null);

  const reglasApi = useReglasSync(apiUrl, siteId, reglas === undefined);
  const reglasActivas = reglas ?? reglasApi;

  useEffect(() => suscribirCola(setCola), []);

  const pendientes = cola.pendientes;
  const rechazadas = cola.rechazadas.length;
  const faltaSubir = pendientes > 0 || rechazadas > 0 || pendientesRonda;

  // Si la cola se vacia mientras el guardia estaba decidiendo, la pregunta deja
  // de tener sentido: se cierra sola y se le dice que ya puede terminar. Y si
  // vuelve a encolarse algo, el "listo" se retira: dejarlo puesto seria mentir.
  useEffect(() => {
    if (!faltaSubir && confirmando) {
      setConfirmando(false);
      setSubioTodo(true);
      return;
    }
    if (faltaSubir && subioTodo) setSubioTodo(false);
  }, [confirmando, faltaSubir, subioTodo]);

  // El foco viaja a la pregunta: en un telefono, un bloque que aparece abajo
  // sin mover el foco es un bloque que el guardia no lee.
  useEffect(() => {
    if (confirmando) tituloConfirmacion.current?.focus();
  }, [confirmando]);

  function intentarTerminar() {
    if (!faltaSubir || !reglasActivas.confirmarAlCerrar) {
      onConfirmar();
      return;
    }
    setConfirmando(true);
  }

  /**
   * `sincronizar()` no intenta nada sin red —el intento colgaria el boton por
   * nada—, asi que aca se dice. Un boton que no hace ni contesta es peor que
   * un boton que explica por que no puede.
   */
  function subirAhora() {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setAvisoAccion('Sin señal: todavía no se puede subir. Busca un punto con conexión.');
      return;
    }
    setAvisoAccion(undefined);
    void sincronizar(apiUrl);
  }

  return (
    <>
      {faltaSubir ? (
        <div className="guardia-aviso" role="status">
          <strong>Todavía no sube todo tu turno.</strong>{' '}
          {pendientes > 0
            ? `Quedan ${pendientes} ${pendientes === 1 ? 'registro' : 'registros'} de tu ronda sin llegar al servidor.`
            : 'Parte de tu ronda todavía no está confirmada por el servidor.'}{' '}
          {rechazadas > 0
            ? `Además hay ${rechazadas} que el servidor rechazó: esos no se suben aunque esperes, avisa a tu supervisor antes de irte.`
            : 'Busca un lugar con señal y espera a que la barra de arriba diga «Todo subido».'}
          <button
            className="guardia-boton-secundario ancho"
            disabled={cola.sincronizando}
            onClick={subirAhora}
            type="button"
          >
            {cola.sincronizando ? 'Subiendo…' : 'Subir ahora'}
          </button>
        </div>
      ) : null}

      {avisoAccion ? (
        <p className="guardia-anuncio" role="status" aria-live="polite">
          {avisoAccion}
        </p>
      ) : null}

      {subioTodo && !faltaSubir ? (
        <p className="guardia-anuncio" role="status" aria-live="polite">
          Listo: ya subió todo. Puedes terminar tu turno.
        </p>
      ) : null}

      {confirmando ? (
        <div className="guardia-error" role="alert">
          <h3 ref={tituloConfirmacion} tabIndex={-1}>
            ¿Terminar el turno con trabajo sin subir?
          </h3>
          <p>
            Lo que quedó guardado en el teléfono se sube solo la próxima vez que abras la app con
            señal. Hasta entonces tu supervisor no ve esa parte de la ronda, y si el teléfono se
            pierde o se borra, esos registros no quedan en ninguna parte.
          </p>
          <button
            className="guardia-boton-primario"
            disabled={cola.sincronizando}
            onClick={subirAhora}
            type="button"
          >
            {cola.sincronizando ? 'Subiendo…' : 'Subir ahora'}
          </button>
          <button
            className="guardia-boton-secundario ancho"
            disabled={marcando}
            onClick={() => {
              setConfirmando(false);
              onConfirmar();
            }}
            type="button"
          >
            {marcando ? 'Marcando…' : 'Sí, terminar igual'}
          </button>
          <button
            className="guardia-boton-secundario ancho"
            onClick={() => setConfirmando(false)}
            type="button"
          >
            Cancelar
          </button>
        </div>
      ) : (
        <button
          className="guardia-boton-primario"
          disabled={marcando}
          onClick={intentarTerminar}
          type="button"
        >
          {marcando ? 'Marcando…' : etiqueta}
        </button>
      )}

      {mensaje ? (
        <p className="guardia-anuncio" role="status" aria-live="polite">
          {mensaje}
        </p>
      ) : null}
    </>
  );
}
