'use client';

/**
 * Historial de auditoria de la configuracion (#102).
 *
 * Cubre el criterio *cada cambio queda en el historial de auditoria*: lo que se
 * muestra sale de `GET /api/admin/audit`, que lee la tabla append-only de
 * PostgreSQL. La API ni siquiera tiene permiso de UPDATE sobre ella, asi que
 * esto es el registro, no una copia que la web mantenga por su cuenta.
 *
 * Se muestra `actorLabel` y NUNCA `actorId`: el id puede apuntar a un usuario ya
 * eliminado y no le dice nada a nadie.
 *
 * Se filtra a las acciones que produce esta pantalla (reglas y modulos). La
 * auditoria completa de la empresa es otra pantalla (#104).
 *
 * Todo se pide desde el navegador y no en el servidor: las horas se formatean
 * en la zona del equipo que mira, y formatearlas en el servidor daria una hora
 * distinta al hidratar.
 */
import { useCallback, useEffect, useState } from 'react';
import type { AnyRuleParameter } from '@sentrycore/shared';

import {
  accionesDeConfiguracion,
  etiquetaAccion,
  ordenarMovimientos,
  resumenEnPalabras,
  type MovimientoAuditoria,
} from './funciones-modelo';
import { pedirJsonConEstado } from './funciones-peticiones';

/**
 * Cuantos movimientos se piden y se muestran. Es tamano de pagina, no una regla
 * de negocio: no cambia lo que hace el sistema, solo cuanto se ve de una vez.
 */
const PASO = 20;

/**
 * Tope duro del servidor: `AuditQuery.limit` lleva `@Max(500)` y el
 * ValidationPipe global corre con `forbidNonWhitelisted`, asi que un limit mayor
 * NO se recorta en silencio: responde 400. Sin este techo, "Ver mas" sumaba de a
 * 20 sin freno y desde la pagina 26 todas las consultas fallaban.
 */
const TOPE_SERVIDOR = 500;

export function FuncionesHistorial({
  parametros,
  apiUrl,
  /** Sube cada vez que el panel guarda algo, para refrescar sin recargar la pagina. */
  refresco = 0,
}: {
  parametros: readonly AnyRuleParameter[];
  apiUrl: string;
  refresco?: number;
}) {
  const [movimientos, setMovimientos] = useState<MovimientoAuditoria[]>([]);
  const [acciones, setAcciones] = useState<string[]>([]);
  const [tope, setTope] = useState(PASO);
  const [cargando, setCargando] = useState(true);
  const [fallo, setFallo] = useState(false);

  const cargar = useCallback(
    async (cuantos: number) => {
      setCargando(true);
      setFallo(false);

      const consulta = await pedirJsonConEstado<string[]>(apiUrl, '/admin/audit/actions', []);
      if (!consulta.ok) {
        // No se pudo preguntar. Se deja lo que ya estaba en pantalla: vaciar la
        // lista aca seria mostrar "no hay cambios" cuando lo cierto es "no
        // sabemos". En una pantalla de auditoria no es lo mismo.
        setFallo(true);
        setCargando(false);
        return;
      }

      const buscadas = accionesDeConfiguracion(consulta.datos);
      setAcciones(buscadas);

      if (!buscadas.length) {
        // Sin acciones registradas no hay nada que pedir. Una lista vacia no es
        // un error: una empresa recien creada todavia no cambio nada.
        setMovimientos([]);
        setCargando(false);
        return;
      }

      const respuestas = await Promise.all(
        buscadas.map((accion) =>
          pedirJsonConEstado<MovimientoAuditoria[]>(
            apiUrl,
            `/admin/audit?action=${encodeURIComponent(accion)}&limit=${cuantos}`,
            [],
          ),
        ),
      );

      // Basta que UNA consulta falle para que la lista quede incompleta, y una
      // lista incompleta de auditoria se lee como si esos cambios no existieran.
      if (respuestas.some((respuesta) => !respuesta.ok)) {
        setFallo(true);
        setCargando(false);
        return;
      }

      setMovimientos(ordenarMovimientos(respuestas.map((respuesta) => respuesta.datos), cuantos));
      setCargando(false);
    },
    [apiUrl],
  );

  useEffect(() => {
    void cargar(tope);
  }, [cargar, tope, refresco]);

  // Mientras el servidor no registre los cambios de modulos, no hay ninguna
  // accion de esa familia. Cuando empiece a registrarlos, el aviso se va solo.
  // Con la consulta fallada no se afirma nada: no sabriamos si existen.
  const faltanModulos = !fallo && !acciones.some((accion) => accion.startsWith('modulos.'));
  const enElTope = tope >= TOPE_SERVIDOR;

  return (
    <section className="management-card management-wide reglas-panel" id="funciones-historial">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Funciones del sistema</span>
          <h2>Historial de cambios</h2>
        </div>
        <span className="status-pill">{movimientos.length} registrados</span>
      </div>

      <p className="section-explanation">
        Quién cambió qué y cuándo. Este registro no se puede editar ni borrar desde el sistema, ni
        siquiera por un administrador.
      </p>

      {faltanModulos ? (
        <p className="reglas-pie-nota">
          Por ahora se registran los cambios de reglas de operación. Los cambios de módulos
          contratados aparecerán acá cuando el servidor empiece a registrarlos.
        </p>
      ) : null}

      {fallo ? (
        <div className="reglas-aviso error" role="status">
          <strong>No pudimos leer el historial</strong>
          <span>
            Lo que se ve abajo puede estar incompleto o viejo. Esto NO significa que no haya
            cambios: significa que no pudimos preguntarlo.
          </span>
          <span className="reglas-barra-acciones">
            <button
              type="button"
              className="secondary-button"
              disabled={cargando}
              onClick={() => void cargar(tope)}
            >
              {cargando ? 'Reintentando…' : 'Reintentar'}
            </button>
          </span>
        </div>
      ) : null}

      {!movimientos.length ? (
        <div className="dashboard-empty">
          <strong>
            {cargando
              ? 'Cargando el historial…'
              : fallo
                ? 'No pudimos leer el historial'
                : 'Todavía no hay cambios registrados'}
          </strong>
          <span>
            {fallo
              ? 'No sabemos si hay cambios registrados: la consulta no respondió.'
              : 'El primer cambio de configuración que guardes va a quedar acá con tu nombre y la hora.'}
          </span>
        </div>
      ) : (
        <>
          <div className="management-list">
            {movimientos.map((movimiento) => (
              <article className="management-row" key={movimiento.id}>
                <div>
                  <strong>{etiquetaAccion(movimiento.action)}</strong>
                  <small>{resumenEnPalabras(movimiento.summary, parametros)}</small>
                  <small>{movimiento.actorLabel}</small>
                </div>
                <span className="state-chip">
                  <time dateTime={movimiento.createdAt}>{fechaLegible(movimiento.createdAt)}</time>
                </span>
              </article>
            ))}
          </div>

          <div className="reglas-barra">
            <span className="reglas-barra-texto">
              Zona horaria de este equipo ({zonaDelEquipo()}).
            </span>
            <span className="reglas-barra-acciones">
              <button
                type="button"
                className="secondary-button"
                disabled={cargando}
                onClick={() => void cargar(tope)}
              >
                {cargando ? 'Actualizando…' : 'Actualizar'}
              </button>
              <button
                type="button"
                className="secondary-button"
                disabled={cargando || enElTope || movimientos.length < tope}
                onClick={() => setTope((previo) => Math.min(previo + PASO, TOPE_SERVIDOR))}
              >
                {enElTope ? `Máximo ${TOPE_SERVIDOR}` : 'Ver más'}
              </button>
            </span>
          </div>
        </>
      )}
    </section>
  );
}

/**
 * Fecha y hora en la zona del equipo que mira.
 *
 * Estos movimientos son de la empresa completa y no cuelgan de un recinto, asi
 * que no hay zona horaria del recinto que aplicar. Se usa la del navegador y se
 * dice cual es al pie de la lista: una hora sin zona declarada es una hora que
 * cada quien lee como quiere.
 */
function fechaLegible(valor: string): string {
  const momento = new Date(valor);
  if (Number.isNaN(momento.getTime())) return 'Fecha ilegible';
  return new Intl.DateTimeFormat('es-CL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(momento);
}

function zonaDelEquipo(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'zona desconocida';
}
