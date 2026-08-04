'use client';

import {
  describirAnomalia,
  type EstadoRonda,
  type PuntoRuta,
  type RegistroPunto,
} from './guard-shift-state';

/**
 * Ejecución guiada punto por punto (#91).
 *
 * La pantalla responde una sola pregunta: A DÓNDE VOY AHORA. El resto de la
 * lista está para ubicarse, no para elegir: el orden lo define la ruta y puede
 * venir sorteado (rutas predecibles son un problema de seguridad, ver CLAUDE.md).
 *
 * Cada punto muestra dos cosas separadas a propósito: lo que pasó en terreno
 * (pendiente / escaneado / con anomalía) y si ya se subió. Una anomalía NO es un
 * escaneo fallido: el sistema marca y avisa, nunca rechaza, porque un GPS
 * impreciso en un subterráneo es condición normal de trabajo.
 */

export type FaseEscaneo = 'inactivo' | 'escaneando' | 'enviando';

export function GuardCheckpointList({
  puntos,
  registros,
  siguiente,
  fase,
  puedeEscanear,
  aviso,
  error,
  anuncio,
  onEscanear,
  onCancelar,
}: {
  puntos: readonly PuntoRuta[];
  registros: EstadoRonda['puntos'];
  siguiente: PuntoRuta | undefined;
  fase: FaseEscaneo;
  puedeEscanear: boolean;
  aviso?: string;
  error?: string;
  anuncio: string;
  onEscanear: () => void;
  onCancelar: () => void;
}) {
  const total = puntos.length;
  const hechos = puntos.filter((punto) => registros[punto.id] !== undefined).length;
  const ocupado = fase !== 'inactivo';

  return (
    <section className="guardia-ronda" aria-labelledby="guardia-destino">
      <p className="guardia-progreso">
        Punto {Math.min(hechos + 1, total)} de {total}
      </p>
      <h2 className="guardia-destino" id="guardia-destino">
        {siguiente ? siguiente.name : 'Ronda completa'}
      </h2>
      {siguiente?.isClosingPoint ? (
        <p className="guardia-nota">Al escanear este punto se cierra la ronda.</p>
      ) : null}

      {siguiente ? (
        <button
          className="guardia-boton-escanear"
          type="button"
          onClick={onEscanear}
          disabled={ocupado || !puedeEscanear}
        >
          {fase === 'escaneando'
            ? 'Acerca el teléfono a la etiqueta'
            : fase === 'enviando'
              ? 'Registrando…'
              : 'Escanear punto'}
        </button>
      ) : null}

      {fase === 'escaneando' ? (
        <button className="guardia-boton-secundario ancho" type="button" onClick={onCancelar}>
          Cancelar escaneo
        </button>
      ) : null}

      {/* Los cambios del escaneo se anuncian: el guardia camina y no mira la pantalla. */}
      <p className="guardia-anuncio" role="status" aria-live="polite">
        {anuncio}
      </p>
      {aviso ? <p className="guardia-aviso">{aviso}</p> : null}
      {error ? (
        <p className="guardia-error" role="alert">
          {error}
        </p>
      ) : null}

      <ol className="guardia-puntos">
        {puntos.map((punto) => (
          <Punto
            key={punto.id}
            punto={punto}
            registro={registros[punto.id]}
            esSiguiente={punto.id === siguiente?.id}
          />
        ))}
      </ol>
    </section>
  );
}

function Punto({
  punto,
  registro,
  esSiguiente,
}: {
  punto: PuntoRuta;
  registro: RegistroPunto | undefined;
  esSiguiente: boolean;
}) {
  const estado = registro?.estado ?? 'pendiente';
  return (
    <li
      className={`guardia-punto ${estado}${esSiguiente ? ' siguiente' : ''}`}
      {...(esSiguiente ? { 'aria-current': 'step' as const } : {})}
    >
      <span className="guardia-punto-orden" aria-hidden="true">
        {punto.position}
      </span>
      <span className="guardia-punto-cuerpo">
        <strong>{punto.name}</strong>
        <span className="guardia-punto-estados">
          <span className={`guardia-chip ${estado}`}>{TEXTO_ESTADO[estado]}</span>
          {registro && !registro.confirmado ? (
            <span className="guardia-chip sin-subir">Sin subir</span>
          ) : null}
        </span>
        {registro?.anomalias.map((codigo) => (
          <small className="guardia-punto-anomalia" key={codigo}>
            {describirAnomalia(codigo)}
          </small>
        ))}
      </span>
    </li>
  );
}

const TEXTO_ESTADO = {
  pendiente: 'Pendiente',
  escaneado: 'Escaneado',
  con_anomalia: 'Escaneado con observación',
} as const;
