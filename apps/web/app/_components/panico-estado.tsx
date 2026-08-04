'use client';

import { useMemo } from 'react';

import type { AlertaPanico, EstadoEntrega } from './panico-envio';

/**
 * Estado de entrega de las alertas de panico (#125).
 *
 * El criterio duro del issue: **el panico nunca falla en silencio**. Si la
 * alerta no salio, el guardia lo ve; si salio, lo ve; y si alguien se hizo
 * cargo, tambien. Sin esto el sistema da la falsa sensacion de control, que es
 * peor que no tener sistema.
 *
 * Y a la vez tiene que ser DISCRETO, que es lo contrario de una alarma:
 *
 *   - se lee como la barra de "3 sin subir" que ya vive arriba de la pantalla;
 *     un tercero que mire de reojo no distingue una alerta de un escaneo;
 *   - no hay `aria-live`. Un lector de pantalla anunciando en voz alta "alerta
 *     de panico enviada" delante de un asaltante es exactamente el riesgo que
 *     el modo silencioso existe para evitar. El guardia lo lee cuando mira;
 *   - no hay sonido, ni vibracion, ni parpadeo.
 *
 * Componente de presentacion pura: el estado vive en `panico-envio.tsx`.
 */

const ETIQUETAS: Record<EstadoEntrega, string> = {
  encolado: 'Sin subir',
  entregado: 'Entregada',
  acusado: 'Recibida',
  rechazado: 'No registrada',
};

export function PanicoEstado({
  alertas,
  onSubirAhora,
  onArchivar,
  zonaHoraria,
}: {
  alertas: readonly AlertaPanico[];
  onSubirAhora: () => void;
  onArchivar: (clientEventId: string) => void;
  /**
   * Zona horaria del RECINTO (`sites.timezone`), no la del servidor. Si no
   * llega se usa la del telefono, que parado dentro del recinto es el mismo
   * reloj que el guardia esta mirando. Ver INTEGRACION.md: hoy
   * `GET /guard/home` no devuelve la zona del recinto.
   */
  zonaHoraria?: string;
}) {
  const hora = useMemo(() => formateadorDeHora(zonaHoraria), [zonaHoraria]);

  if (!alertas.length) return null;

  const sinSubir = alertas.some((alerta) => alerta.estado === 'encolado');

  return (
    <section aria-labelledby="panico-estado-titulo" className="panico-estado">
      <h4 id="panico-estado-titulo">Tus avisos</h4>

      <ul className="panico-lista">
        {alertas.map((alerta) => (
          <li className={`panico-alerta ${alerta.estado}`} key={alerta.clientEventId}>
            <span className={`guardia-chip panico-chip ${alerta.estado}`}>
              {ETIQUETAS[alerta.estado]}
            </span>
            <time dateTime={alerta.disparadaAt}>{hora(alerta.disparadaAt)}</time>
            <p>{describir(alerta, hora)}</p>
            {alerta.estado === 'encolado' ? null : (
              <button
                className="guardia-boton-texto"
                onClick={() => onArchivar(alerta.clientEventId)}
                type="button"
              >
                Listo
              </button>
            )}
          </li>
        ))}
      </ul>

      {sinSubir ? (
        <button className="guardia-boton-secundario ancho" onClick={onSubirAhora} type="button">
          Reintentar ahora
        </button>
      ) : null}
    </section>
  );
}

/**
 * Cada estado dice una cosa distinta y ninguna se adorna. "Entregada" sin saber
 * si alguien fue avisado NO se muestra como "ya la recibieron": el guardia
 * decide si insiste por radio con lo que de verdad sabemos.
 */
function describir(alerta: AlertaPanico, hora: (iso: string) => string): string {
  if (alerta.falsaAlarma) {
    return 'Corregida como falsa alarma. La alerta no se borra: tu explicación queda anotada al lado.';
  }
  switch (alerta.estado) {
    case 'encolado':
      return 'Guardada en el teléfono. Se envía sola apenas haya señal. Avisa también por radio.';
    case 'entregado':
      if (alerta.avisado === true) return 'Enviada. Ya la recibieron.';
      if (alerta.avisado === false) {
        return 'Enviada, pero no había a quién avisar. Comunícate por radio.';
      }
      return 'Enviada. Quedó registrada en el servidor.';
    case 'acusado':
      return alerta.acusadaPor
        ? `Recibida por ${alerta.acusadaPor}${alerta.acusadaAt ? ` a las ${hora(alerta.acusadaAt)}` : ''}.`
        : 'Alguien se hizo cargo de tu aviso.';
    case 'rechazado':
      return `No quedó registrada: ${alerta.motivo ?? 'el servidor la rechazó'}. Vuelve a mantener presionado el botón y avisa por radio.`;
  }
}

/**
 * `Intl.DateTimeFormat` lanza si la zona no existe, y la zona viene de la base
 * de datos. Un recinto mal configurado no puede dejar sin pantalla al guardia.
 */
function formateadorDeHora(zonaHoraria: string | undefined): (iso: string) => string {
  const opciones: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  let formato: Intl.DateTimeFormat;
  try {
    formato = new Intl.DateTimeFormat('es-CL', {
      ...opciones,
      ...(zonaHoraria ? { timeZone: zonaHoraria } : {}),
    });
  } catch {
    formato = new Intl.DateTimeFormat('es-CL', opciones);
  }

  return (iso: string) => {
    const fecha = new Date(iso);
    return Number.isNaN(fecha.getTime()) ? '--:--' : formato.format(fecha);
  };
}
