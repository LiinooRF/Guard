'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { GuardCheckpointList, type FaseEscaneo } from './guard-checkpoint-list';
import { GuardConnectionBar } from './guard-connection-bar';
import { GuardEventForm } from './guard-event-form';
import {
  enviarEscaneo,
  enviarNovedad,
  iniciarAutoSync,
  subirFotoNovedad,
  suscribirVeredictos,
  type Criticidad,
  type PayloadNovedad,
} from './guard-outbox';
import {
  aplicarVeredictos,
  cargarEstadoRonda,
  estadoInicial,
  guardarEstadoRonda,
  marcarFotoSubida,
  puntosFaltantes,
  registrarCierre,
  registrarEscaneo,
  registrarNovedad,
  siguientePunto,
  type CierreRonda,
  type EstadoRonda,
  type PuntoRuta,
} from './guard-shift-state';
import { GuardShiftSummary } from './guard-shift-summary';
import { nuevoUuid } from './guard-storage';
import {
  ErrorEscaneoPortal,
  useGuardBridge,
  type ResultadoEscaneoPayload,
} from './use-guard-bridge';

/**
 * La pantalla del guardia dentro del WebView (#91 a #94).
 *
 * Coordina las tres partes —ejecución guiada, novedades y cierre— y sostiene la
 * regla que las cruza: NADA depende de tener señal. Cada acción se manda al
 * servidor si se puede y se encola si no, y la barra de arriba dice siempre en
 * cuál de los dos estados está el trabajo del guardia.
 */

export interface GuardShiftData {
  hasAssignment: boolean;
  message?: string;
  shift?: { scheduledStartAt: string; scheduledEndAt: string };
  patrol?: {
    id: string;
    status: string;
    siteName: string;
    routeName: string;
    estimatedDurationMin: number;
    completedCheckpointCount: number;
    checkpoints: PuntoRuta[];
  };
  synchronization: { pendingItems: number };
}

const hora = new Intl.DateTimeFormat('es-CL', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
  timeZone: 'America/Santiago',
});

/**
 * Fotos de novedades que todavía no tienen id de servidor. Viven en memoria: una
 * foto en base64 no cabe en localStorage y guardarla en IndexedDB es un trabajo
 * aparte. Si el WebView se cierra antes de sincronizar, la foto se pierde y la
 * pantalla lo dice desde el formulario. Ver INTEGRACION.md.
 */
const fotosPendientes = new Map<string, File>();

export function GuardShift({ data, apiUrl }: { data: GuardShiftData; apiUrl: string }) {
  if (!data.hasAssignment || data.patrol === undefined || data.shift === undefined) {
    return <SinAsignacion apiUrl={apiUrl} mensaje={data.message} />;
  }
  return <Ronda apiUrl={apiUrl} patrol={data.patrol} shift={data.shift} />;
}

function SinAsignacion({ apiUrl, mensaje }: { apiUrl: string; mensaje?: string }) {
  const puente = useGuardBridge();
  return (
    <>
      <GuardConnectionBar apiUrl={apiUrl} conexion={puente.conexion} />
      <section className="empty-assignment">
        <span className="empty-icon" aria-hidden="true">
          ✓
        </span>
        <h2>No tienes un turno asignado</h2>
        <p>{mensaje ?? 'Cuando te asignen una ronda, aparecerá aquí automáticamente.'}</p>
      </section>
    </>
  );
}

type Vista = 'ronda' | 'novedad' | 'resumen';

function Ronda({
  patrol,
  shift,
  apiUrl,
}: {
  patrol: NonNullable<GuardShiftData['patrol']>;
  shift: NonNullable<GuardShiftData['shift']>;
  apiUrl: string;
}) {
  const puente = useGuardBridge();
  const [estado, setEstado] = useState<EstadoRonda>(() => estadoInicial(patrol.id));
  const [vista, setVista] = useState<Vista>('ronda');
  const [fase, setFase] = useState<FaseEscaneo>('inactivo');
  const [anuncio, setAnuncio] = useState('');
  const [errorEscaneo, setErrorEscaneo] = useState<string>();
  const [enviandoNovedad, setEnviandoNovedad] = useState(false);
  const [mensajeNovedad, setMensajeNovedad] = useState<string>();

  const puntos = useMemo(
    () => [...patrol.checkpoints].sort((a, b) => a.position - b.position),
    [patrol.checkpoints],
  );

  const actualizar = useCallback((cambio: (actual: EstadoRonda) => EstadoRonda) => {
    setEstado((actual) => {
      const siguiente = cambio(actual);
      guardarEstadoRonda(siguiente);
      return siguiente;
    });
  }, []);

  // Lo que quedó en el teléfono manda: `GET /guard/home` no devuelve los puntos
  // ya escaneados, así que sin esto una recarga a mitad de ronda los borra.
  // Se lee después de montar para no romper la hidratación.
  useEffect(() => {
    setEstado(cargarEstadoRonda(patrol.id));
  }, [patrol.id]);

  useEffect(() => iniciarAutoSync(apiUrl), [apiUrl]);

  useEffect(
    () =>
      suscribirVeredictos((veredictos) => {
        actualizar((actual) => aplicarVeredictos(actual, veredictos));

        // La foto esperaba el id que solo aparece cuando la novedad llega al
        // servidor. Este es el momento en que existe.
        for (const veredicto of veredictos) {
          const foto = fotosPendientes.get(veredicto.clientId);
          if (!foto || veredicto.status === 'rechazado' || !veredicto.serverId) continue;
          fotosPendientes.delete(veredicto.clientId);
          void subirFotoNovedad(apiUrl, veredicto.serverId, foto).then((subida) => {
            actualizar((actual) => marcarFotoSubida(actual, veredicto.clientId, subida));
          });
        }
      }),
    [actualizar, apiUrl],
  );

  const siguiente = siguientePunto(puntos, estado.puntos);

  async function escanear() {
    const destino = siguiente;
    if (destino === undefined) return;

    setErrorEscaneo(undefined);
    setFase('escaneando');
    setAnuncio('Acerca el teléfono a la etiqueta del punto.');

    let lectura: ResultadoEscaneoPayload;
    try {
      lectura = await puente.escanear(`Punto ${destino.name}`);
    } catch (causa) {
      setFase('inactivo');
      const detalle = describirFalloDeEscaneo(causa);
      setAnuncio(detalle ?? 'Escaneo cancelado.');
      if (detalle !== undefined) setErrorEscaneo(detalle);
      return;
    }

    setFase('enviando');
    setAnuncio('Registrando el punto…');

    const clientScanId = nuevoUuid();
    const envio = await enviarEscaneo(apiUrl, patrol.id, {
      uid: lectura.uid,
      method: 'nfc',
      clientScanId,
      scannedAt: lectura.scannedAt,
      ...(lectura.latitude === undefined ? {} : { latitude: lectura.latitude }),
      ...(lectura.longitude === undefined ? {} : { longitude: lectura.longitude }),
      ...(lectura.accuracyM === undefined ? {} : { accuracyM: lectura.accuracyM }),
    });
    setFase('inactivo');

    if (envio.clase === 'rechazado') {
      setErrorEscaneo(envio.mensaje);
      setAnuncio(envio.mensaje);
      return;
    }

    if (envio.clase === 'encolado') {
      // Atribución PROVISIONAL al punto que tocaba: sin señal, el teléfono no
      // sabe a qué punto pertenece la etiqueta —eso lo resuelve el servidor—, y
      // dejar el escaneo sin mostrar sería peor. Queda marcado "sin subir" y el
      // veredicto de la sincronización lo confirma o lo devuelve a pendiente.
      actualizar((actual) => {
        const conPunto = registrarEscaneo(actual, {
          checkpointId: destino.id,
          clientScanId,
          anomalias: [],
          confirmado: false,
          scannedAt: lectura.scannedAt,
        });
        if (!destino.isClosingPoint) return conPunto;
        return registrarCierre(conPunto, cierreProvisional(conPunto, puntos, clientScanId));
      });
      setAnuncio(`Punto ${destino.name} guardado sin señal. Se sube solo cuando vuelva.`);
      if (destino.isClosingPoint) setVista('resumen');
      return;
    }

    const respuesta = envio.respuesta;
    const cerrada = respuesta.patrol.status === 'completada';
    actualizar((actual) => {
      const conPunto = registrarEscaneo(actual, {
        checkpointId: respuesta.checkpoint.id,
        clientScanId,
        anomalias: respuesta.anomalies,
        confirmado: true,
        scannedAt: lectura.scannedAt,
      });
      if (!cerrada) return conPunto;
      return registrarCierre(conPunto, {
        cerradaAt: new Date().toISOString(),
        scanned: respuesta.progress.scanned,
        expected: respuesta.progress.expected,
        faltantes: respuesta.progress.missedCheckpointIds,
        pct: respuesta.progress.pct,
        alertaEnviada: respuesta.alertSent,
        confirmado: true,
        clientScanId,
      });
    });

    const conObservacion = respuesta.anomalies.length ? ' con observación' : '';
    setAnuncio(
      `Punto ${respuesta.checkpoint.name} registrado${conObservacion}. ` +
        `${respuesta.progress.scanned} de ${respuesta.progress.expected}.`,
    );
    if (cerrada) setVista('resumen');
  }

  async function reportar(entrada: { criticidad: Criticidad; texto?: string; foto?: File }) {
    setEnviandoNovedad(true);
    setMensajeNovedad(undefined);

    const clientEventId = nuevoUuid();
    const reportadaAt = new Date().toISOString();
    const payload: PayloadNovedad = {
      criticality: entrada.criticidad,
      clientEventId,
      patrolId: patrol.id,
      reportedAt: reportadaAt,
      ...(entrada.texto ? { text: entrada.texto } : {}),
    };
    if (entrada.foto) fotosPendientes.set(clientEventId, entrada.foto);

    const envio = await enviarNovedad(apiUrl, payload);
    const esPanico = entrada.criticidad === 'panico';

    if (envio.clase === 'rechazado') {
      fotosPendientes.delete(clientEventId);
      setMensajeNovedad(envio.mensaje);
      setEnviandoNovedad(false);
      return;
    }

    actualizar((actual) =>
      registrarNovedad(actual, {
        clientEventId,
        criticidad: entrada.criticidad,
        ...(entrada.texto ? { texto: entrada.texto } : {}),
        reportadaAt,
        confirmada: envio.clase === 'confirmado',
        notificada: envio.clase === 'confirmado' && envio.respuesta.notified,
        conFoto: entrada.foto !== undefined,
        fotoSubida: false,
      }),
    );

    if (envio.clase === 'encolado') {
      setMensajeNovedad(
        esPanico
          ? 'Sin señal. La alerta quedó guardada y sale sola apenas haya conexión. Avisa también por radio.'
          : 'Sin señal. La novedad quedó guardada y se sube sola.',
      );
      setEnviandoNovedad(false);
      return;
    }

    const idEvento = envio.respuesta.id;
    setMensajeNovedad(
      envio.respuesta.notified
        ? esPanico
          ? 'Alerta enviada. Ya la recibieron.'
          : 'Novedad registrada y avisada.'
        : 'Quedó registrada, pero no había a quién avisar. Comunícate por radio.',
    );

    const foto = fotosPendientes.get(clientEventId);
    if (foto && idEvento) {
      fotosPendientes.delete(clientEventId);
      const subida = await subirFotoNovedad(apiUrl, idEvento, foto);
      actualizar((actual) => marcarFotoSubida(actual, clientEventId, subida));
      if (!subida) setMensajeNovedad('La novedad quedó registrada, pero la foto no se pudo subir.');
    }
    setEnviandoNovedad(false);
  }

  return (
    <>
      <GuardConnectionBar apiUrl={apiUrl} conexion={puente.conexion} />

      <section className="guardia-cabecera">
        <p className="guardia-eyebrow">{patrol.siteName}</p>
        <h1 className="guardia-titulo">{patrol.routeName}</h1>
        <p className="guardia-turno">
          Turno {hora.format(new Date(shift.scheduledStartAt))} a{' '}
          {hora.format(new Date(shift.scheduledEndAt))} · {patrol.estimatedDurationMin} min
          estimados
        </p>
      </section>

      {vista === 'ronda' ? (
        <>
          <GuardCheckpointList
            anuncio={anuncio}
            fase={fase}
            onCancelar={puente.cancelarEscaneo}
            onEscanear={() => void escanear()}
            puedeEscanear={puente.puedeEscanear}
            puntos={puntos}
            registros={estado.puntos}
            siguiente={siguiente}
            {...(puente.aviso ? { aviso: puente.aviso } : {})}
            {...(errorEscaneo ? { error: errorEscaneo } : {})}
          />
          <nav className="guardia-acciones" aria-label="Otras acciones">
            <button
              className="guardia-boton-secundario ancho"
              onClick={() => setVista('novedad')}
              type="button"
            >
              Reportar novedad
            </button>
            {estado.cierre ? (
              <button
                className="guardia-boton-secundario ancho"
                onClick={() => setVista('resumen')}
                type="button"
              >
                Ver resumen
              </button>
            ) : null}
          </nav>
        </>
      ) : null}

      {vista === 'novedad' ? (
        <>
          <GuardEventForm
            enviando={enviandoNovedad}
            onPanico={() => void reportar({ criticidad: 'panico' })}
            onReportar={(entrada) => void reportar(entrada)}
            {...(mensajeNovedad ? { mensaje: mensajeNovedad } : {})}
          />
          <button
            className="guardia-boton-secundario ancho"
            onClick={() => setVista('ronda')}
            type="button"
          >
            Volver a la ronda
          </button>
        </>
      ) : null}

      {vista === 'resumen' ? (
        <GuardShiftSummary
          apiUrl={apiUrl}
          estado={estado}
          onVolver={() => setVista('ronda')}
          puntos={puntos}
        />
      ) : null}
    </>
  );
}

/**
 * Cierre calculado con lo que sabe el teléfono, sin porcentaje: el umbral de
 * cumplimiento es configuración de cada empresa y el cliente no lo conoce.
 */
function cierreProvisional(
  estado: EstadoRonda,
  puntos: readonly PuntoRuta[],
  clientScanId: string,
): CierreRonda {
  const faltantes = puntosFaltantes(puntos, estado.puntos);
  return {
    cerradaAt: new Date().toISOString(),
    scanned: puntos.length - faltantes.length,
    expected: puntos.length,
    faltantes: faltantes.map((punto) => punto.id),
    alertaEnviada: false,
    confirmado: false,
    clientScanId,
  };
}

/**
 * `undefined` significa "no hay nada que mostrar": el guardia canceló. Se
 * ramifica por el código cerrado del contrato y nunca por el texto, que se
 * puede reescribir sin romper nada.
 */
function describirFalloDeEscaneo(causa: unknown): string | undefined {
  if (causa instanceof ErrorEscaneoPortal) {
    return causa.codigo === 'cancelado' ? undefined : causa.message;
  }
  if (causa instanceof Error && causa.message === 'sin-puente') {
    return 'Esta pantalla solo escanea desde la app VoxIA Control del teléfono.';
  }
  if (causa instanceof Error && causa.message === 'puente-incompatible') {
    return 'Tu app quedó desactualizada para este portal. Actualízala desde Google Play.';
  }
  return 'La app del teléfono no respondió al escaneo. Vuelve a intentarlo.';
}
