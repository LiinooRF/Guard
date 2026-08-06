'use client';

import {
  BOTON_QR_PRINCIPAL,
  BOTON_QR_RESPALDO,
  ETIQUETA_METODO,
  NOTA_QR_RESPALDO,
  type OpcionesEscaneo,
} from './guard-escaneo-modelo';
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
 *
 * El respaldo por QR (#227) se pinta con dos jerarquías distintas y eso NO es
 * decoración: con antena es un botón secundario debajo del grande, y sin antena
 * pasa a ser el botón grande pero con su etiqueta de respaldo encima. Si los dos
 * caminos se vieran iguales, nadie compraría etiquetas NFC y el producto perdería
 * la única evidencia que obliga a pisar el punto — un QR se fotografía una vez y
 * se reusa desde la garita.
 */

export type FaseEscaneo = 'inactivo' | 'escaneando' | 'escaneando-qr' | 'enviando';

export function GuardCheckpointList({
  puntos,
  registros,
  siguiente,
  fase,
  opciones,
  aviso,
  error,
  anuncio,
  onEscanear,
  onEscanearQr,
  onCancelar,
}: {
  puntos: readonly PuntoRuta[];
  registros: EstadoRonda['puntos'];
  siguiente: PuntoRuta | undefined;
  fase: FaseEscaneo;
  /** Qué caminos ofrece la pantalla. Lo decide `opcionesDeEscaneo`. */
  opciones: OpcionesEscaneo;
  aviso?: string;
  error?: string;
  anuncio: string;
  onEscanear: () => void;
  onEscanearQr: () => void;
  onCancelar: () => void;
}) {
  const total = puntos.length;
  const hechos = puntos.filter((punto) => registros[punto.id] !== undefined).length;
  const ocupado = fase !== 'inactivo';
  const soloQr = opciones.modo === 'solo-qr';

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

      {/* Mientras el puente saluda —y en el escritorio del supervisor, donde no
          hay puente— el botón sigue apareciendo DESHABILITADO, como siempre. Que
          desapareciera y volviera movería la pantalla bajo el dedo del guardia.
          Solo se retira cuando el QR pasa a ser el camino, que es otro botón. */}
      {siguiente && !soloQr ? (
        <button
          className="guardia-boton-escanear"
          type="button"
          onClick={onEscanear}
          disabled={ocupado || !opciones.nfc}
        >
          {fase === 'escaneando'
            ? 'Acerca el teléfono a la etiqueta'
            : fase === 'enviando'
              ? 'Registrando…'
              : 'Escanear punto'}
        </button>
      ) : null}

      {siguiente && soloQr ? (
        <>
          {/* La marca va ARRIBA del botón: se lee antes de apretarlo, no
              después. Es la diferencia entre informar y justificarse. */}
          <p className="guardia-marca-respaldo">Respaldo por QR</p>
          <button
            className="guardia-boton-escanear respaldo"
            type="button"
            onClick={onEscanearQr}
            disabled={ocupado}
          >
            {fase === 'escaneando-qr'
              ? 'Apunta la cámara al código del punto'
              : fase === 'enviando'
                ? 'Registrando…'
                : BOTON_QR_PRINCIPAL}
          </button>
          <p className="guardia-nota">{NOTA_QR_RESPALDO}</p>
        </>
      ) : null}

      {siguiente && opciones.qr && !soloQr ? (
        <button
          className="guardia-boton-secundario ancho"
          type="button"
          onClick={onEscanearQr}
          disabled={ocupado}
        >
          {fase === 'escaneando-qr' ? 'Apunta la cámara al código' : BOTON_QR_RESPALDO}
        </button>
      ) : null}

      {fase === 'escaneando' || fase === 'escaneando-qr' ? (
        <button className="guardia-boton-secundario ancho" type="button" onClick={onCancelar}>
          {fase === 'escaneando-qr' ? 'Cerrar la cámara' : 'Cancelar escaneo'}
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
          {/* Solo se marca el QR. Poner también "NFC" en cada punto llenaría la
              lista con una etiqueta que no dice nada: NFC es lo normal y lo que
              hay que ver de un vistazo es la excepción. */}
          {registro?.metodo === 'qr' ? (
            <span className="guardia-chip por-qr">Por {ETIQUETA_METODO.qr}</span>
          ) : null}
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
