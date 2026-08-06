'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { GuardChecklist } from './guard-checklist';
import { marcarSalidaDeJornada } from './guard-outbox';
import {
  ETIQUETAS_CRITICIDAD,
  hayPendientesDeSubir,
  olvidarEstadoRonda,
  puntosPorQr,
  type EstadoRonda,
  type PuntoRuta,
} from './guard-shift-state';

/**
 * Cierre y resumen del turno (#93).
 *
 * Aparece sola al escanear el punto de cierre: el servidor cierra la ronda con
 * su porcentaje real y esta pantalla lo muestra. El porcentaje NO se calcula
 * acá — el umbral de cumplimiento es configuración de cada empresa y el teléfono
 * no lo conoce ni tiene por qué. Cuando el cierre viaja en la cola, se muestran
 * los conteos y se dice que el cumplimiento lo confirma el servidor.
 *
 * Las novedades listadas son las de ESTE teléfono: el guardia no tiene permiso
 * para leer la bandeja del recinto (`patrols:monitor` es del supervisor), y está
 * bien que así sea.
 */

const hora = new Intl.DateTimeFormat('es-CL', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Santiago',
});

export function GuardShiftSummary({
  estado,
  puntos,
  apiUrl,
  onVolver,
}: {
  estado: EstadoRonda;
  puntos: readonly PuntoRuta[];
  apiUrl: string;
  onVolver: () => void;
}) {
  const router = useRouter();
  const [salida, setSalida] = useState<string>();
  const [marcando, setMarcando] = useState(false);
  const cierre = estado.cierre;
  if (!cierre) return null;

  const faltantes = puntos.filter((punto) => cierre.faltantes.includes(punto.id));
  const pendientes = hayPendientesDeSubir(estado);
  const porQr = puntosPorQr(estado);

  async function terminarJornada() {
    setMarcando(true);
    const resultado = await marcarSalidaDeJornada(apiUrl);
    setSalida(resultado.mensaje);
    setMarcando(false);
    if (resultado.ok && !pendientes) {
      olvidarEstadoRonda(estado.patrolId);
      router.refresh();
    }
  }

  return (
    <section className="guardia-resumen" aria-labelledby="guardia-resumen-titulo">
      <h2 id="guardia-resumen-titulo">
        {cierre.confirmado ? 'Ronda cerrada' : 'Ronda terminada, falta subirla'}
      </h2>

      {cierre.pct === undefined ? (
        <p className="guardia-nota">
          El cumplimiento lo calcula el servidor cuando esta ronda se suba.
        </p>
      ) : (
        <p className="guardia-cumplimiento">
          <strong>{cierre.pct}%</strong>
          <span>de cumplimiento</span>
        </p>
      )}

      <p className="guardia-resumen-conteo">
        {cierre.scanned} de {cierre.expected} puntos escaneados
      </p>

      {/* El respaldo se dice en el cierre, no solo punto por punto: es el número
          que el supervisor mira para saber si esa ronda vale lo mismo que las
          otras, y es el que delata una etiqueta rota que nadie fue a cambiar. */}
      {porQr > 0 ? (
        <p className="guardia-resumen-conteo por-qr">
          {porQr === 1
            ? '1 punto marcado por QR (respaldo)'
            : `${porQr} puntos marcados por QR (respaldo)`}
        </p>
      ) : null}

      {faltantes.length ? (
        <div className="guardia-faltantes">
          <h3>Puntos sin escanear</h3>
          <ul>
            {faltantes.map((punto) => (
              <li key={punto.id}>
                {punto.position}. {punto.name}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="guardia-nota">No quedó ningún punto sin escanear.</p>
      )}

      {cierre.alertaEnviada ? (
        <p className="guardia-aviso">
          El cumplimiento quedó bajo el umbral de tu empresa y se avisó al administrador.
        </p>
      ) : null}

      <div className="guardia-novedades-turno">
        <h3>Novedades del turno</h3>
        {estado.novedades.length ? (
          <ul>
            {estado.novedades.map((novedad) => (
              <li key={novedad.clientEventId}>
                <span className={`guardia-chip criticidad-${novedad.criticidad}`}>
                  {ETIQUETAS_CRITICIDAD[novedad.criticidad]}
                </span>
                <time dateTime={novedad.reportadaAt}>
                  {hora.format(new Date(novedad.reportadaAt))}
                </time>
                <p>{novedad.texto ?? 'Alerta de pánico'}</p>
                {novedad.confirmada ? null : <span className="guardia-chip sin-subir">Sin subir</span>}
                {novedad.conFoto && !novedad.fotoSubida ? (
                  <span className="guardia-chip sin-subir">Foto sin subir</span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="guardia-nota">No registraste novedades en este turno.</p>
        )}
        <p className="guardia-nota">Se listan las registradas desde este teléfono.</p>
      </div>

      <GuardChecklist apiUrl={apiUrl} patrolId={estado.patrolId} />

      <button
        className="guardia-boton-primario"
        disabled={marcando}
        onClick={() => void terminarJornada()}
        type="button"
      >
        {marcando ? 'Marcando…' : 'Marcar salida de jornada'}
      </button>
      {salida ? (
        <p className="guardia-anuncio" role="status" aria-live="polite">
          {salida}
        </p>
      ) : null}
      {pendientes ? (
        <p className="guardia-aviso">
          Todavía queda trabajo por subir. No cierres la app hasta que la barra de arriba diga
          &laquo;Todo subido&raquo;.
        </p>
      ) : null}

      <button className="guardia-boton-secundario ancho" onClick={onVolver} type="button">
        Volver a la ronda
      </button>
    </section>
  );
}
