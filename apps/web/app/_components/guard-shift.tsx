'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

import { GuardCheckpointList, type FaseEscaneo } from './guard-checkpoint-list';
import {
  motivoQrInvalido,
  opcionesDeEscaneo,
  type MetodoEscaneo,
} from './guard-escaneo-modelo';
import { PanicoPanel } from './panico-panel';
import { SyncEstado } from './sync-estado';
import { GuardEventForm } from './guard-event-form';
import {
  enviarEscaneo,
  enviarNovedad,
  iniciarAutoSync,
  pedirApi,
  subirFotoNovedad,
  subirFotoPunto,
  suscribirVeredictos,
  type Criticidad,
  type PayloadNovedad,
} from './guard-outbox';
import { GuardTareasPunto } from './guard-tareas-punto';
import { useTrazaEnVivo } from './use-guard-traza';
import { adoptarFotosDeTareas, sincronizarTareas } from './guard-tareas-flujo';
import {
  cargarEstadoTareas,
  cargarPlantillaTareas,
  estadoTareasInicial,
  guardarEstadoTareas,
  guardarPlantillaTareas,
  itemsDeLaPlantilla,
  tareasDelPuntoPorResponder,
  type EstadoTareas,
  type ItemTarea,
  type PlantillaTareas,
} from './guard-tareas-modelo';
import {
  aplicarVeredictos,
  cargarEstadoRonda,
  estadoInicial,
  guardarEstadoRonda,
  marcarFotoPuntoSubida,
  marcarFotoSubida,
  puntoExigeFoto,
  puntosFaltantes,
  reconciliarConServidor,
  registrarCierre,
  registrarEscaneo,
  registrarNovedad,
  siguientePunto,
  type CierreRonda,
  type EstadoRonda,
  type PoliticaFoto,
  type PuntoRuta,
} from './guard-shift-state';
import { GuardScanPhoto } from './guard-scan-photo';
import {
  efectoDelDesenlace,
  fotosDePuntoAdoptables,
  guardarYSubirFotoDePunto,
  nuevoRegistroIdsDeEscaneo,
  type FotoDePunto,
} from './guard-scan-photo-flow';
import { GuardShiftSummary } from './guard-shift-summary';
import { procesarFoto } from './guard-photo';
import {
  borrarFoto,
  clasificarPendientes,
  conSubidaExclusiva,
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
  type ResultadoEscaneoQrPayload,
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
  /**
   * Regla `allowQrFallback` del recinto (#227). Si la API no la manda —portal
   * nuevo contra API vieja, que dura lo que dura un deploy— se asume permitido:
   * es el valor por omisión del catálogo y dejar al guardia sin ningún camino
   * sería el peor de los dos errores posibles.
   */
  qrFallbackEnabled?: boolean;
  /**
   * Horario hábil del recinto y las reglas de foto, para que la pantalla decida
   * sin señal con `isPhotoRequired()` de `@voxia/shared`. Ver guard-shift-state.
   */
  photoPolicy?: PoliticaFoto;
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
function subirFotoPersistida(
  apiUrl: string,
  clientEventId: string,
  serverId: string,
): Promise<boolean | undefined> {
  // Una sola subida por foto aunque la pidan dos caminos a la vez: el del
  // veredicto de la cola y el de la foto recien tomada se cruzan justo cuando la
  // señal vuelve a mitad del procesado. Ver conSubidaExclusiva.
  return conSubidaExclusiva(clientEventId, async () => {
    const guardada = await leerFoto(clientEventId);
    if (!guardada) return undefined;
    // Se manda la hora de CAPTURA que quedo guardada con la foto, no la de ahora:
    // esta subida puede ocurrir horas despues, al recuperar señal.
    //
    // El destino decide el endpoint: la foto de un punto cuelga del escaneo y la
    // de una novedad, del evento. El almacén guarda las dos y por eso lo dice.
    const subir = guardada.destino === 'escaneo' ? subirFotoPunto : subirFotoNovedad;
    const subida = await subir(apiUrl, serverId, guardada.blob as File, guardada.takenAtDevice);
    if (subida) await borrarFoto(clientEventId);
    return subida;
  });
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
      qrPermitido={data.qrFallbackEnabled !== false}
      {...(data.photoBudget ? { presupuestoFoto: data.photoBudget } : {})}
      {...(data.photoPolicy ? { politicaFoto: data.photoPolicy } : {})}
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
  qrPermitido,
  presupuestoFoto,
  politicaFoto,
}: {
  patrol: NonNullable<GuardShiftData['patrol']>;
  shift: NonNullable<GuardShiftData['shift']>;
  apiUrl: string;
  qrPermitido: boolean;
  presupuestoFoto?: GuardShiftData['photoBudget'];
  politicaFoto?: PoliticaFoto;
}) {
  const puente = useGuardBridge(apiUrl);
  const [estado, setEstado] = useState<EstadoRonda>(() => estadoInicial(patrol.id));
  const [vista, setVista] = useState<Vista>('ronda');
  /*
   * La traza en vivo (#280): mientras la ronda este abierta, el shell muestrea
   * y este portal sube las posiciones. `Ronda` solo se monta con la ronda en
   * curso, asi que "activa" es simplemente "sin cierre" — y el cierre, el
   * desmontaje o un shell viejo apagan el grifo sin tocar nada mas.
   */
  useTrazaEnVivo({ puente, apiUrl, patrolId: patrol.id, activa: estado.cierre === undefined });
  const [fase, setFase] = useState<FaseEscaneo>('inactivo');
  const [anuncio, setAnuncio] = useState('');
  const [errorEscaneo, setErrorEscaneo] = useState<string>();
  const [enviandoNovedad, setEnviandoNovedad] = useState(false);
  const [mensajeNovedad, setMensajeNovedad] = useState<string>();
  const [fotosPorSubir, setFotosPorSubir] = useState(0);
  const [fotoDePunto, setFotoDePunto] = useState<FotoDePunto>();
  const [guardandoFotoPunto, setGuardandoFotoPunto] = useState(false);
  const [avisoFotoPunto, setAvisoFotoPunto] = useState<string>();
  // La foto de este punto ya está a salvo en el teléfono aunque no haya subido.
  // Cambia lo que dicen el botón de postergar y su nota: "sigues sin foto" sería
  // falso, y de esa clase de mentira se trata todo este panel.
  const [fotoPuntoGuardada, setFotoPuntoGuardada] = useState(false);
  // Los ids de escaneo que ya devolvió el servidor, fuera del estado de React y
  // fuera de la vuelta de renderizado: quien los tiene que leer es la subida de
  // la foto, que empezó ANTES de que llegaran y no ve los cambios de estado
  // posteriores. Se crea una sola vez (inicializador perezoso de useState).
  const [idsDeEscaneo] = useState(nuevoRegistroIdsDeEscaneo);
  // Las tareas del turno (#265): la plantilla y lo respondido en esta ronda.
  const [itemsTareas, setItemsTareas] = useState<ItemTarea[]>([]);
  const [tareas, setTareas] = useState<EstadoTareas>(() => estadoTareasInicial(patrol.id));
  const [puntoConTareas, setPuntoConTareas] = useState<{
    checkpointId: string;
    nombre: string;
    clientScanId: string;
    scanId?: string;
  }>();

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

  // Lo local se CRUZA con el servidor, ya no manda a secas. La regla vieja
  // ("lo que quedó en el teléfono manda") era obligada cuando `guard/home`
  // traía el avance en cero; sus dos consecuencias se vieron en un teléfono
  // real: un avance fantasma que sobrevivía a reinstalar la app, y un escaneo
  // perdido que dejaba el punto como hecho PARA SIEMPRE. Ahora: lo confirmado
  // por el servidor gana; lo pendiente en cola gana el teléfono.
  // Se lee después de montar para no romper la hidratación.
  useEffect(() => {
    const reconciliado = reconciliarConServidor(cargarEstadoRonda(patrol.id), puntos);
    // Se persiste de inmediato: si el estado viejo tenía un fantasma, dejarlo
    // en el disco es dejarlo listo para reaparecer en la próxima recarga.
    guardarEstadoRonda(reconciliado);
    setEstado(reconciliado);
  }, [patrol.id, puntos]);

  useEffect(() => iniciarAutoSync(apiUrl), [apiUrl]);

  const actualizarTareas = useCallback((siguiente: EstadoTareas) => {
    guardarEstadoTareas(siguiente);
    setTareas(siguiente);
  }, []);

  /**
   * Las tareas del turno se piden AL ENTRAR a la ronda y se guardan (#265).
   *
   * Antes la plantilla se pedía en el resumen, o sea después del punto de
   * cierre: en un subterráneo eso significa que la tarea del punto 3 no existió
   * nunca. Guardada en el teléfono, la ronda entera se puede hacer sin señal.
   *
   * De paso se repara lo que quedó a medias en la sesión anterior: la foto de
   * una tarea que esperaba el id de su escaneo y las respuestas que nunca
   * llegaron a subir.
   */
  useEffect(() => {
    let vivo = true;
    const guardada = cargarPlantillaTareas(patrol.id);
    if (guardada) setItemsTareas(itemsDeLaPlantilla(guardada));
    const local = cargarEstadoTareas(patrol.id);
    setTareas(local);

    void (async () => {
      const registros = cargarEstadoRonda(patrol.id).puntos;
      const sincronizado = await sincronizarTareas(
        apiUrl,
        await adoptarFotosDeTareas(apiUrl, local, registros),
      );
      if (vivo && sincronizado !== local) actualizarTareas(sincronizado);

      try {
        const respuesta = await pedirApi(apiUrl, `/checklists/patrols/${patrol.id}/template`);
        if (!respuesta.ok || !vivo) return;
        const plantilla = (await respuesta.json()) as PlantillaTareas;
        guardarPlantillaTareas(patrol.id, plantilla);
        setItemsTareas(itemsDeLaPlantilla(plantilla));
      } catch {
        // Sin señal manda la plantilla guardada: para eso se guarda.
      }
    })();

    return () => {
      vivo = false;
    };
  }, [actualizarTareas, apiUrl, patrol.id]);

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
          // Las dos marcas: cada una busca por el id de cliente en su propia
          // lista, así que la que no corresponde deja el estado igual.
          actualizar((actual) =>
            marcarFotoPuntoSubida(
              marcarFotoSubida(actual, foto.clientEventId, subida),
              foto.clientEventId,
              subida,
            ),
          );
        }
      }

      // Reparación en frío de la foto de un punto que quedó sin el id de su
      // escaneo. El veredicto de una operación llega UNA vez y después sale de
      // la cola, así que nadie se lo vuelve a ofrecer; el estado de la ronda, en
      // cambio, sí persiste y `aplicarVeredictos()` le dejó el `scanId`. Se lee
      // del almacenamiento y no del estado de React porque este efecto corre
      // antes de que el otro lo cargue.
      const registros = cargarEstadoRonda(patrol.id).puntos;
      for (const { clientScanId, scanId } of fotosDePuntoAdoptables(pendientes, registros)) {
        await fijarServerId(clientScanId, scanId);
        const subida = await subirFotoPersistida(apiUrl, clientScanId, scanId);
        if (subida !== undefined) {
          actualizar((actual) => marcarFotoPuntoSubida(actual, clientScanId, subida));
        }
      }

      if (vivo) await refrescarFotosPendientes();
    })();
    return () => {
      vivo = false;
    };
  }, [apiUrl, actualizar, patrol.id, refrescarFotosPendientes]);

  useEffect(
    () =>
      suscribirVeredictos((veredictos) => {
        actualizar((actual) => aplicarVeredictos(actual, veredictos));

        // La foto esperaba el id que solo aparece cuando la operación llega al
        // servidor. Este es el momento en que existe: se fija en el almacén
        // (para reintentar aunque la subida falle) y se sube.
        //
        // Vale igual para la novedad y para el punto: el `serverId` del
        // veredicto es el id del evento o el del escaneo según el tipo de la
        // operación, y `subirFotoPersistida` elige el endpoint por el destino
        // que la foto lleva guardado.
        for (const veredicto of veredictos) {
          if (veredicto.status === 'rechazado' || !veredicto.serverId) continue;
          const { clientId, serverId } = veredicto;
          // Lo PRIMERO, y sin pasar por el estado de React: puede haber una foto
          // procesándose en este mismo instante que lo va a releer al terminar.
          // Si el id solo viajara por `setFotoDePunto`, esa foto —que ya capturó
          // su pendiente— se guardaría sin id y se quedaría sin subir para
          // siempre, porque este veredicto no vuelve a pasar.
          idsDeEscaneo.anotar(clientId, serverId);
          // El panel de la foto puede estar abierto esperando justo este id.
          setFotoDePunto((actual) =>
            actual && actual.clientScanId === clientId ? { ...actual, scanId: serverId } : actual,
          );
          void fijarServerId(clientId, serverId)
            .then(() => subirFotoPersistida(apiUrl, clientId, serverId))
            .then((subida) => {
              if (subida === undefined) return;
              // Las dos marcas se aplican siempre: cada una busca por el id de
              // cliente en su propia lista, así que la que no corresponde no
              // encuentra nada y deja el estado igual.
              actualizar((actual) =>
                marcarFotoPuntoSubida(marcarFotoSubida(actual, clientId, subida), clientId, subida),
              );
              if (subida) {
                setFotoDePunto((actual) =>
                  actual?.clientScanId === clientId ? undefined : actual,
                );
              }
              void refrescarFotosPendientes();
            });
        }

        // La foto de una TAREA cuelga del mismo escaneo, así que este también es
        // el instante en que existe su id (#265). Sin esto, una tarea respondida
        // sin señal esperaría a que el guardia reabra la app: su respuesta no
        // puede salir de la cola hasta que la foto esté arriba.
        //
        // Los registros se arman con los veredictos y no con el estado de la
        // ronda: `actualizar()` persiste dentro del updater de React, que todavía
        // no corrió cuando esta línea se ejecuta.
        const escaneosConId: Record<string, { clientScanId: string; scanId: string }> = {};
        for (const veredicto of veredictos) {
          if (veredicto.status === 'rechazado' || !veredicto.serverId) continue;
          escaneosConId[veredicto.clientId] = {
            clientScanId: veredicto.clientId,
            scanId: veredicto.serverId,
          };
        }
        void (async () => {
          const actual = cargarEstadoTareas(patrol.id);
          const siguiente = await sincronizarTareas(
            apiUrl,
            await adoptarFotosDeTareas(apiUrl, actual, escaneosConId),
          );
          if (siguiente !== actual) actualizarTareas(siguiente);
        })();
      }),
    [actualizar, actualizarTareas, apiUrl, idsDeEscaneo, patrol.id, refrescarFotosPendientes],
  );

  const siguiente = siguientePunto(puntos, estado.puntos);
  // El panel de tareas se apaga solo cuando ya no queda ninguna por responder,
  // así el guardia no tiene que cerrarlo a mano para seguir.
  const tareasEnPantalla =
    puntoConTareas !== undefined &&
    tareasDelPuntoPorResponder(itemsTareas, tareas, puntoConTareas.checkpointId).length > 0;

  // Qué caminos ofrece la pantalla: lo que puede el TELÉFONO (lo trae el puente)
  // cruzado con lo que permite la EMPRESA (lo trae la API en la cascada del
  // recinto). La decisión vive en `guard-escaneo-modelo` porque es la única
  // parte de esto que se puede probar sin navegador.
  const opcionesEscaneo = opcionesDeEscaneo({
    hayPuente: puente.fase === 'listo',
    tieneNfc: !puente.sinAntenaNfc,
    puedeEscanearQr: puente.puedeEscanearQr,
    qrPermitidoPorReglas: qrPermitido,
  });
  // Lo que diga el puente manda: "no hay app" o "el shell no respondió" explica
  // mejor que cualquier texto sobre métodos de marcado.
  const avisoPantalla = puente.aviso ?? opcionesEscaneo.aviso;

  /**
   * Marca el punto que toca. El MÉTODO no es un detalle de implementación: viaja
   * a la API, queda en la fila del escaneo y sale en el informe. Un punto
   * marcado por QR es evidencia más débil que uno de etiqueta —el QR se
   * fotografía y se reusa— y el supervisor tiene derecho a distinguirlos (#227).
   */
  async function marcarPunto(metodo: MetodoEscaneo) {
    const destino = siguiente;
    if (destino === undefined) return;
    const esQr = metodo === 'qr';

    setErrorEscaneo(undefined);
    setFase(esQr ? 'escaneando-qr' : 'escaneando');
    setAnuncio(
      esQr
        ? 'Apunta la cámara al código QR pegado en el punto.'
        : 'Acerca el teléfono a la etiqueta del punto.',
    );

    let lectura: ResultadoEscaneoPayload | ResultadoEscaneoQrPayload;
    try {
      lectura = esQr
        ? await puente.escanearQr(`Punto ${destino.name}`)
        : await puente.escanear(`Punto ${destino.name}`);
    } catch (causa) {
      setFase('inactivo');
      const detalle = describirFalloDeEscaneo(causa);
      setAnuncio(detalle ?? 'Escaneo cancelado.');
      if (detalle !== undefined) setErrorEscaneo(detalle);
      return;
    }

    // Un QR ajeno —un afiche pegado al lado del punto— se descarta acá y no en
    // la API: sin señal el envío se encola y el guardia se iría creyendo que
    // marcó, para descubrir horas después que ese punto quedó pendiente.
    const invalido = esQr ? motivoQrInvalido(lectura.uid) : undefined;
    if (invalido !== undefined) {
      setFase('inactivo');
      setErrorEscaneo(invalido);
      setAnuncio(invalido);
      return;
    }

    setFase('enviando');
    setAnuncio('Registrando el punto…');

    const clientScanId = lectura.clientScanId ?? nuevoUuid();
    const envio = await enviarEscaneo(apiUrl, patrol.id, {
      uid: lectura.uid,
      method: metodo,
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
      //
      // Sin señal la foto la decide el teléfono con la política del recinto que
      // llegó en `GET /guard/home`: es de eso que se trata mandarla.
      const exigeFoto = puntoExigeFoto(destino, politicaFoto);
      actualizar((actual) => {
        const conPunto = registrarEscaneo(actual, {
          checkpointId: destino.id,
          clientScanId,
          anomalias: [],
          confirmado: false,
          scannedAt: lectura.scannedAt,
          metodo,
          fotoRequerida: exigeFoto,
        });
        if (!destino.isClosingPoint) return conPunto;
        return registrarCierre(conPunto, cierreProvisional(conPunto, puntos, clientScanId));
      });
      const guardadoSinSenal =
        `Punto ${destino.name} guardado sin señal${esQr ? ' por QR' : ''}.`;
      setAnuncio(`${guardadoSinSenal} Se sube solo cuando vuelva.`);
      // Las tareas de este punto también se ofrecen sin señal: se responden, se
      // guardan y suben solas. Se deja pedido ANTES del early return de la foto,
      // así el panel aparece apenas la foto del acceso se resuelva.
      ofrecerTareasDelPunto({ checkpointId: destino.id, nombre: destino.name, clientScanId });
      // La foto se pide igual estando sin señal: se guarda en el teléfono y sube
      // sola con el id que devuelva la sincronización. Va ANTES del resumen para
      // que el punto de cierre no se salte su evidencia.
      if (exigeFoto) {
        pedirFotoDelPunto(
          { checkpointId: destino.id, nombre: destino.name, clientScanId },
          `${guardadoSinSenal} Ahora fotografía el acceso.`,
        );
        return;
      }
      if (destino.isClosingPoint) setVista('resumen');
      return;
    }

    const respuesta = envio.respuesta;
    // 'completada' O 'incompleta': desde que el cierre dice la verdad (#258, el
    // estado sale de un CASE sobre el porcentaje), un cierre parcial responde
    // 'incompleta' — y sigue siendo un CIERRE. Mirar solo 'completada' dejaba
    // al portal ignorando el cierre justo en las rondas con puntos faltantes.
    const cerrada = ['completada', 'incompleta'].includes(respuesta.patrol.status);
    // Manda el veredicto del servidor, que evaluó el horario del recinto en este
    // instante; si no lo pudo resolver, decide el teléfono con su política. Una
    // ronda de ocho horas cruza el cierre del recinto y la instantánea de
    // `GET /guard/home` queda vieja justo en los puntos del final.
    const puntoEscaneado = puntos.find((punto) => punto.id === respuesta.checkpoint.id) ?? destino;
    const exigeFoto =
      respuesta.checkpoint.photoRequired ?? puntoExigeFoto(puntoEscaneado, politicaFoto);
    actualizar((actual) => {
      const conPunto = registrarEscaneo(actual, {
        checkpointId: respuesta.checkpoint.id,
        clientScanId,
        anomalias: respuesta.anomalies,
        confirmado: true,
        scannedAt: lectura.scannedAt,
        metodo,
        fotoRequerida: exigeFoto,
        ...(respuesta.scanId ? { scanId: respuesta.scanId } : {}),
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

    ofrecerTareasDelPunto({
      checkpointId: respuesta.checkpoint.id,
      nombre: respuesta.checkpoint.name,
      clientScanId,
      ...(respuesta.scanId ? { scanId: respuesta.scanId } : {}),
    });

    const conObservacion = respuesta.anomalies.length ? ' con observación' : '';
    // "por QR" se dice en voz alta: el guardia camina y no mira la pantalla, y
    // esta es la única forma de que se entere de que quedó marcado como respaldo.
    //
    // (B9) Y si el punto YA estaba marcado, se le dice con la hora del primero:
    // antes el guardia repetía el escaneo sin ninguna señal de que el anterior
    // había contado, que es justo la duda que lo hace repetir.
    setAnuncio(
      respuesta.alreadyScanned
        ? `El punto ${respuesta.checkpoint.name} ya estaba marcado` +
          `${respuesta.firstScannedAt ? ` a las ${hora.format(new Date(respuesta.firstScannedAt))}` : ''}. ` +
          'Para el informe vale la primera marca.'
        : `Punto ${respuesta.checkpoint.name} registrado${esQr ? ' por QR' : ''}${conObservacion}. ` +
          `${respuesta.progress.scanned} de ${respuesta.progress.expected}.`,
    );
    if (exigeFoto) {
      // El anuncio propio repite "por QR" y la observación a propósito: pisa al
      // de arriba —los dos setAnuncio caen en la misma tanda de React— y sin
      // esto el respaldo por QR dejaba de decirse en voz alta justo en los
      // puntos que exigen foto, que son los que más importan.
      pedirFotoDelPunto(
        {
          checkpointId: respuesta.checkpoint.id,
          nombre: respuesta.checkpoint.name,
          clientScanId,
          ...(respuesta.scanId ? { scanId: respuesta.scanId } : {}),
        },
        `Punto ${respuesta.checkpoint.name} registrado${esQr ? ' por QR' : ''}${conObservacion}. ` +
          'Ahora fotografía el acceso.',
      );
      return;
    }
    if (cerrada) setVista('resumen');
  }

  /**
   * Deja pedidas las tareas del punto recién marcado (#265).
   *
   * Solo si quedan tareas suyas sin responder: un punto sin tareas no interrumpe
   * la ronda, y uno ya respondido no vuelve a preguntar cuando el guardia lo
   * re-escanea.
   */
  function ofrecerTareasDelPunto(punto: {
    checkpointId: string;
    nombre: string;
    clientScanId: string;
    scanId?: string;
  }) {
    if (!tareasDelPuntoPorResponder(itemsTareas, tareas, punto.checkpointId).length) return;
    setPuntoConTareas(punto);
  }

  function pedirFotoDelPunto(pendiente: FotoDePunto, anuncioPropio?: string) {
    setAvisoFotoPunto(undefined);
    setFotoPuntoGuardada(false);
    setFotoDePunto(pendiente);
    setAnuncio(anuncioPropio ?? `Punto ${pendiente.nombre} registrado. Ahora fotografía el acceso.`);
  }

  /**
   * La foto recién tomada del punto: se procesa (marca de agua con fecha y hora
   * del recinto, y compresión al peso que fijó el admin), se guarda en el
   * almacén persistente y recién entonces se intenta subir.
   *
   * Ese orden es el que importa: si la subida falla o no hay señal, la foto ya
   * está a salvo y se manda sola después. Subir primero y guardar después deja
   * al guardia sin evidencia cada vez que se corta la red, que es la condición
   * normal de trabajo, no la excepción.
   *
   * El QUÉ decide dónde cuelga la foto vive en `guard-scan-photo-flow.ts`, con
   * sus pruebas: procesar tarda segundos y el id del escaneo puede llegar en el
   * medio, así que no se puede decidir con lo que se sabía al empezar. Acá queda
   * solo lo que es de la pantalla.
   */
  async function registrarFotoDelPunto(archivo: File) {
    const pendiente = fotoDePunto;
    if (!pendiente) return;

    setGuardandoFotoPunto(true);
    setAvisoFotoPunto(undefined);
    const tomadaAt = new Date().toISOString();
    const desenlace = await guardarYSubirFotoDePunto(pendiente, archivo, tomadaAt, {
      procesar: (entrada) =>
        procesarFoto(entrada, {
          sitio: patrol.siteName,
          ruta: patrol.routeName,
          ...(patrol.timezone ? { zonaHoraria: patrol.timezone } : {}),
          ...(presupuestoFoto ? { objetivoBytes: presupuestoFoto.targetBytes } : {}),
        }),
      guardar: (clientScanId, foto, cuando, scanId) =>
        guardarFoto(clientScanId, foto, cuando, scanId, 'escaneo'),
      fijarId: fijarServerId,
      subir: (clientScanId, scanId) => subirFotoPersistida(apiUrl, clientScanId, scanId),
      idDelEscaneo: (clientScanId) => idsDeEscaneo.resolver(clientScanId),
      alGuardar: refrescarFotosPendientes,
    });

    if (desenlace.subida !== undefined) {
      const subida = desenlace.subida;
      actualizar((actual) => marcarFotoPuntoSubida(actual, pendiente.clientScanId, subida));
    }
    await refrescarFotosPendientes();
    setGuardandoFotoPunto(false);

    // QUÉ se le dice al guardia y SI el panel se cierra lo decide el flujo, que
    // sí tiene pruebas. El orden de estas líneas importa y ya se equivocó una
    // vez: el aviso solo se pinta dentro del panel, así que cerrarlo antes de
    // escribirlo es lo mismo que no escribirlo.
    const efecto = efectoDelDesenlace(desenlace, pendiente.nombre);
    setFotoPuntoGuardada(efecto.guardadaSinSubir);
    setAvisoFotoPunto(efecto.aviso);
    setAnuncio(efecto.anuncio);
    if (efecto.mantenerPanel) return;

    setFotoDePunto(undefined);
    cerrarPuntoConFoto(pendiente);
  }

  /** Si el punto fotografiado era el de cierre, ahora sí toca el resumen. */
  function cerrarPuntoConFoto(pendiente: FotoDePunto) {
    const punto = puntos.find((candidato) => candidato.id === pendiente.checkpointId);
    if (punto?.isClosingPoint) setVista('resumen');
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

      {vista === 'ronda' && fotoDePunto ? (
        <GuardScanPhoto
          esperando={guardandoFotoPunto}
          guardadaSinSubir={fotoPuntoGuardada}
          nombrePunto={fotoDePunto.nombre}
          onFoto={(archivo) => void registrarFotoDelPunto(archivo)}
          onPostergar={() => {
            const pendiente = fotoDePunto;
            setFotoDePunto(undefined);
            setAnuncio(
              fotoPuntoGuardada
                ? `La foto de ${pendiente.nombre} está guardada y se envía sola. Puedes seguir.`
                : `El punto ${pendiente.nombre} quedó sin su foto obligatoria.`,
            );
            cerrarPuntoConFoto(pendiente);
          }}
          {...(avisoFotoPunto ? { aviso: avisoFotoPunto } : {})}
        />
      ) : null}

      {/* Las tareas van DESPUÉS de la foto obligatoria del acceso: esa es la
          evidencia que no se puede perder y el panel es uno solo a la vez. */}
      {vista === 'ronda' && !fotoDePunto && puntoConTareas ? (
        <GuardTareasPunto
          apiUrl={apiUrl}
          checkpointId={puntoConTareas.checkpointId}
          clientScanId={puntoConTareas.clientScanId}
          estado={tareas}
          foto={{
            sitio: patrol.siteName,
            ruta: patrol.routeName,
            ...(patrol.timezone ? { zonaHoraria: patrol.timezone } : {}),
            ...(presupuestoFoto ? { objetivoBytes: presupuestoFoto.targetBytes } : {}),
          }}
          idDelEscaneo={() => idsDeEscaneo.resolver(puntoConTareas.clientScanId)}
          items={itemsTareas}
          nombrePunto={puntoConTareas.nombre}
          onEstado={actualizarTareas}
          onListo={() => setPuntoConTareas(undefined)}
          {...(puntoConTareas.scanId ? { scanId: puntoConTareas.scanId } : {})}
        />
      ) : null}

      {/*
        El mapa NO va en la pantalla del guardia: es una herramienta de
        SUPERVISION (decisión de producto, 8-ago-2026). El guardia camina
        mirando el punto y la etiqueta, no la pantalla — la misma razón por la
        que el escaneo se confirma con una vibración y los cambios se anuncian
        en voz alta. Un mapa ahí compite por la atención justo cuando hace falta
        en el mundo físico, y además gasta datos de tiles en terreno.

        Quien sí lo necesita ya lo tiene: el supervisor tiene el mapa de
        recintos (`/app/supervisor/mapa`), el de guardias en vivo
        (`live-guard-map`) y el editor de rutas.

        `GuardMapa` y `guard-mapa-modelo` se CONSERVAN, no se borran: el visor
        de ruta con tiles offline es trabajo hecho y probado (#76), y esta es
        una decisión de dónde mostrarlo, no de si sirve.
      */}
      {vista === 'ronda' ? (
        <>
          <GuardCheckpointList
            anuncio={anuncio}
            fase={fase}
            onCancelar={fase === 'escaneando-qr' ? puente.cancelarEscaneoQr : puente.cancelarEscaneo}
            onEscanear={() => void marcarPunto('nfc')}
            onEscanearQr={() => void marcarPunto('qr')}
            opciones={opcionesEscaneo}
            // Con una foto obligatoria en pantalla no se marca el punto
            // siguiente: la evidencia del que se acaba de marcar va primero.
            esperandoFoto={fotoDePunto !== undefined}
            // Y con las tareas del punto abiertas, lo mismo: no bloquean la
            // ronda —«Seguir con la ronda» las cierra en un toque— pero mientras
            // están en pantalla, el punto de al lado espera.
            esperandoTareas={tareasEnPantalla}
            puntos={puntos}
            registros={estado.puntos}
            siguiente={siguiente}
            {...(politicaFoto ? { politicaFoto } : {})}
            {...(avisoPantalla ? { aviso: avisoPantalla } : {})}
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
    if (causa.codigo === 'cancelado') return undefined;
    // El único permiso que se pide para marcar un punto es el de la cámara: NFC
    // no tiene permiso en tiempo de ejecución en Android. Un permiso denegado no
    // es una falla técnica, es algo que el guardia puede arreglar, así que el
    // texto dice DÓNDE se arregla en vez de repetir el código del error.
    if (causa.codigo === 'permiso-denegado') {
      return 'La app no tiene permiso para usar la cámara. Actívalo en los ajustes del ' +
        'teléfono, en Aplicaciones › VoxIA Control › Permisos, y vuelve a intentarlo.';
    }
    return causa.message;
  }
  if (causa instanceof Error && causa.message === 'sin-puente') {
    return 'Esta pantalla solo escanea desde la app VoxIA Control del teléfono.';
  }
  if (causa instanceof Error && causa.message === 'puente-incompatible') {
    return 'Tu app quedó desactualizada para este portal. Actualízala desde Google Play.';
  }
  return 'La app del teléfono no respondió al escaneo. Vuelve a intentarlo.';
}
