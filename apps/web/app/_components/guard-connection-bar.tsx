'use client';

import { useEffect, useState } from 'react';

import type { EstadoConexionPayload } from '../_lib/bridge/protocol';
import {
  descartarRechazadas,
  sincronizar,
  suscribirCola,
  type EstadoCola,
} from './guard-outbox';

/**
 * Estado de conexión y cola de pendientes (#94).
 *
 * Va SIEMPRE visible y pegada arriba. Es el requisito que hace útil a todo lo
 * demás: si el guardia no sabe si lo que hizo se subió, repite escaneos o los da
 * por perdidos, y las dos cosas ensucian el informe.
 *
 * Dice tres cosas distintas y no las mezcla:
 *   - si el teléfono tiene señal,
 *   - cuánto trabajo suyo falta por subir,
 *   - qué se rechazó y por qué (eso no se descarta solo: lo cierra el guardia).
 */

const COLA_VACIA: EstadoCola = { pendientes: 0, rechazadas: [], sincronizando: false };

const hora = new Intl.DateTimeFormat('es-CL', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Santiago',
});

export function GuardConnectionBar({
  conexion,
  apiUrl,
}: {
  conexion: EstadoConexionPayload;
  apiUrl: string;
}) {
  const [cola, setCola] = useState<EstadoCola>(COLA_VACIA);

  useEffect(() => suscribirCola(setCola), []);

  const pendientes = cola.pendientes;
  const resumen = cola.sincronizando
    ? 'Subiendo…'
    : pendientes === 0
      ? 'Todo subido'
      : `${pendientes} sin subir`;

  return (
    <div className="guardia-conexion">
      <p className="guardia-conexion-linea" role="status" aria-live="polite">
        <span
          className={`guardia-senal ${conexion.enLinea ? 'ok' : 'sin'}`}
          aria-hidden="true"
        />
        <strong>{conexion.enLinea ? 'Con señal' : 'Sin señal'}</strong>
        <span className={pendientes ? 'guardia-cola alerta' : 'guardia-cola'}>{resumen}</span>
        {cola.ultimoEnvioAt ? (
          <small>Último envío {hora.format(new Date(cola.ultimoEnvioAt))}</small>
        ) : null}
      </p>

      {pendientes > 0 ? (
        <button
          className="guardia-boton-secundario"
          type="button"
          onClick={() => void sincronizar(apiUrl)}
          disabled={cola.sincronizando}
        >
          {cola.sincronizando ? 'Subiendo…' : 'Subir ahora'}
        </button>
      ) : null}

      {cola.rechazadas.length ? (
        <div className="guardia-rechazos" role="alert">
          <strong>
            {cola.rechazadas.length === 1
              ? 'Una operación no se pudo registrar'
              : `${cola.rechazadas.length} operaciones no se pudieron registrar`}
          </strong>
          <ul>
            {cola.rechazadas.map((operacion) => (
              <li key={operacion.clientId}>
                {operacion.type === 'scan' ? 'Escaneo' : 'Novedad'}:{' '}
                {operacion.motivo ?? 'El servidor la rechazó.'}
              </li>
            ))}
          </ul>
          <button className="guardia-boton-secundario" type="button" onClick={descartarRechazadas}>
            Entendido
          </button>
        </div>
      ) : null}
    </div>
  );
}
