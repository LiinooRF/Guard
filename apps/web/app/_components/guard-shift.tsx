'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { GuardCheckpointList, type FaseEscaneo } from './guard-checkpoint-list';
import { GuardMapa } from './guard-mapa';
import { PanicoPanel } from './panico-panel';
import { SyncEstado } from './sync-estado';
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
import { procesarFoto } from './guard-photo';
import {
  borrarFoto,
  clasificarPendientes,
  contarPendientes,
  fijarServerId,
  guardarFoto,
  leerFoto,
  listarPendientes,
} from './guard-photo-store';
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
  /** Presupuesto de la foto, resuelto por la API en la cascada del recinto. */
  photoBudget?: { targetBytes: number; maxBytes: number };
  patrol?: {
    id: string;
    status: string;
    siteName: string;
    /** Zona horaria del RECINTO, que manda la API. Ver guard-photo.ts. */
    timezone?: string;
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
 * Sube la foto de una novedad desde el almacén persistente y, si el servidor la
 * recibe, la borra de ahí. Devuelve `undefined` cuando esa novedad no tenía foto.
 *
 * Las fotos ya no viven en memoria sino en IndexedDB (`guard-photo-store`, #70):
 * si el WebView se cierra antes de sincronizar, la foto no se pierde y se sube al
 * reabrir o al recuperar señal.
 */
async function subirFotoPersistida(
  apiUrl: string,
  clientEventId: string,
  serverId: string,
): Promise<boolean | undefined> {
  const guardada = await leerFoto(clientEventId);
  if (!guardada) return undefined;
  // Se manda la hora de CAPTURA que quedo guardada con la foto, no la de ahora:
  // esta subida puede ocurrir horas despues, al recuperar señal.
  const subida = await subirFotoNovedad(
    apiUrl,
    serverId,
    guardada.blob as File,
    guardada.takenAtDevice,
  );
  if (subida) await borrarFoto(clientEventId);
  return subida;
}

export function GuardShift({ data, apiUrl }: { data: GuardShiftData; apiUrl: string }) {
  if (!data.hasAssignment || data.patrol === undefined || data.shift === undefined) {
    return <SinAsignacion apiUrl={apiUrl} mensaje={data.message} />;
  }
  return (
    <Ronda
      apiUrl={apiUrl}
      patrol={data.patrol}
      shift={data.shift}
      {...(data.photoBudget ? { presupuestoFoto: data.photoBudget } : {})}
    />
  );
}

function SinAsignacion({ apiUrl, mensaje }: { apiUrl: string; mensaje?: string }) {
  const puente = useGuardBridge(apiUrl);
  return (
    <>
      <SyncEstado apiUrl={apiUrl} conexion={puente.conexion} />
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
  presupuestoFoto,
}: {
  patrol: NonNullable<GuardShiftData['patrol']>;
  shift: NonNullable<GuardShiftData['shift']>;
  apiUrl: string;
  presupuestoFoto?: GuardShiftData['photoBudget'];
}) {
  const puente = useGuardBridge(apiUrl);
  const [estado, setEstado] = useState<EstadoRonda>(() => estadoInicial(patrol.id));
  const [vista, setVista] = useState<Vista>('ronda');
  const [fase, setFase] = useState<FaseEscaneo>('inactivo');
  const [anuncio, setAnuncio] = useState('');
  const [errorEscaneo, setErrorEscaneo] = useState<string>();
  const [enviandoNovedad, setEnviandoNovedad] = useState(false);
  const [mensajeNovedad, setMensajeNovedad] = useState<string>();
  const [fotosPorSubir, setFotosPorSubir] = useState(0);

  const refrescarFotosPendientes = useCallback(async () => {
    setFotosPorSubir(await contarPendientes());
  }, []);

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

  // Al montar (o al reabrir tras cerrar el WebView), rehidrata las fotos que
  // quedaron sin subir: las que ya tienen id de servidor se reintentan ahora, y
  // las que aún esperan el id lo reciben por el veredicto de la cola de texto.
  // Ver #70.
  useEffect(() => {
    let vivo = true;
    void (async () => {
      const pendientes = await listarPendientes();
      if (vivo) setFotosPorSubir(pendientes.length);
      for (const foto of clasificarPendientes(pendientes).listas) {
        if (!foto.serverId) continue;
        const subida = await subirFotoPersistida(apiUrl, foto.clientEventId, foto.serverId);
        if (subida !== undefined) {
          actualizar((actual) => marcarFotoSubida(actual, foto.clientEventId, subida));
        }
      }
      if (vivo) await refrescarFotosPendientes();
    })();
    return () => {
      vivo = false;
    };
  }, [apiUrl, actualizar, refrescarFotosPendientes]);

  useEffect(
    () =>
      suscribirVeredictos((veredictos) => {
        actualizar((actual) => aplicarVeredictos(actual, veredictos));

        // La foto esperaba el id que solo aparece cuando la novedad llega al
        // servidor. Este es el momento en que existe: se fija en el almacén
        // (para reintentar aunque la subida falle) y se sube.
        for (const veredicto of veredictos) {
          if (veredicto.status === 'rechazado' || !veredicto.serverId) continue;
          const { clientId, serverId } = veredicto;
          void fijarServerId(clientId, serverId)
            .then(() => subirFotoPersistida(apiUrl, clientId, serverId))
            .then((subida) => {
              if (subida === undefined) return;
              actualizar((actual) => marcarFotoSubida(actual, clientId, subida));
              void refrescarFotosPendientes();
            });
        }
      }),
    [actualizar, apiUrl, refrescarFotosPendientes],
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

    const clientScanId = lectura.clientScanId ?? nuevoUuid();
    const envio = await enviarEscaneo(apiUrl, patrol.id, {
      uid: lectura.uid,
      method: 'nfc',
      clientScanId,
      scannedAt: lectura.scannedAt,
      ...(lectura.latitude === undefined ? {} : { latitude: lectura.latitude }),
      ...(lectura.longitude === undefined ? {} : { longitude: lectura.longitude }),
      ...(lectura.accuracyM === undefined ? {} : { accuracyM: lectura.accuracyM }),
      ...(lectura.deviceId === undefined ? {} : { deviceId: lectura.deviceId }),
      ...(lectura.signature === undefined ? {} : { signature: lectura.signature }),
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
    // Antes de encolarla: se reescala, se le quema la marca de agua con fecha y
    // hora y se comprime bajo el objetivo de tamaño (#67). La versión liviana y
    // trazable se guarda en el almacén persistente (#70): sobrevive al cierre del
    // WebView y se sube sola.
    if (entrada.foto) {
      const foto = await procesarFoto(entrada.foto, {
        sitio: patrol.siteName,
        ruta: patrol.routeName,
        // La zona del recinto: la hora se quema en los pixeles y no se corrige
        // despues. Si la API no la manda, cae en la del dispositivo.
        ...(patrol.timezone ? { zonaHoraria: patrol.timezone } : {}),
        // El peso objetivo lo decide el ADMIN por recinto, no este archivo: una
        // bodega con fibra y un perimetro rural no quieren lo mismo.
        ...(presupuestoFoto ? { objetivoBytes: presupuestoFoto.targetBytes } : {}),
      });
      await guardarFoto(clientEventId, foto, reportadaAt);
      await refrescarFotosPendientes();
    }

    const envio = await enviarNovedad(apiUrl, payload);
    const esPanico = entrada.criticidad === 'panico';

    if (envio.clase === 'rechazado') {
      await borrarFoto(clientEventId);
      await refrescarFotosPendientes();
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

    if (entrada.foto && idEvento) {
      await fijarServerId(clientEventId, idEvento);
      const subida = await subirFotoPersistida(apiUrl, clientEventId, idEvento);
      if (subida !== undefined) {
        actualizar((actual) => marcarFotoSubida(actual, clientEventId, subida));
        if (!subida) {
          setMensajeNovedad('La novedad quedó registrada, pero la foto no se pudo subir.');
        }
      }
      await refrescarFotosPendientes();
    }
    setEnviandoNovedad(false);
  }

  return (
    <>
      <SyncEstado apiUrl={apiUrl} conexion={puente.conexion} />

      {fotosPorSubir > 0 ? (
        <p className="guardia-anuncio" role="status" aria-live="polite">
          {fotosPorSubir === 1
            ? 'Queda 1 foto por subir. Se envía sola al recuperar señal.'
            : `Quedan ${fotosPorSubir} fotos por subir. Se envían solas al recuperar señal.`}
        </p>
      ) : null}

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
          <GuardMapa
            puntos={puntos}
            registros={estado.puntos}
            siteName={patrol.siteName}
            {...(siguiente ? { siguiente } : {})}
          />
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
          <PanicoPanel
            apiUrl={apiUrl}
            {...(patrol?.id ? { patrolId: patrol.id } : {})}
          />
          <GuardEventForm
            enviando={enviandoNovedad}
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
