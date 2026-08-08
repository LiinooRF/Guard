'use client';

import { useCallback, useEffect, useState } from 'react';

import type {
  EstadoConexionPayload,
  PuntoDeTrazaPayload,
  ResultadoEscaneoPayload,
  ResultadoEscaneoQrPayload,
  RutaOfflinePayload,
} from '../_lib/bridge/protocol';
import { crearClientePuente } from '../_lib/bridge/web-client';
import {
  EVENTO_CONSENTIMIENTO_ACEPTADO,
  reportarPermisoUbicacion,
  traducirEstadoPermiso,
} from './guard-permiso-ubicacion';

export { ErrorEscaneoPortal } from '../_lib/bridge/web-client';
export type {
  ResultadoEscaneoPayload,
  ResultadoEscaneoQrPayload,
} from '../_lib/bridge/protocol';

/**
 * El puente nativo visto desde React (#91, #94).
 *
 * La Web NFC API no está expuesta dentro del WebView: el escaneo lo hace el
 * shell nativo y viaja por `postMessage`. Este hook no inventa mensajes, usa el
 * cliente del contrato (`_lib/bridge/web-client.ts`, copia literal de
 * `apps/mobile/src/bridge/`).
 *
 * Que no haya puente NO es un error: el mismo portal se abre en el navegador de
 * escritorio del supervisor. Ahí simplemente no se puede escanear, y la pantalla
 * lo dice sin pintar una falla.
 */

const SIN_PUENTE =
  'Esta pantalla escanea solo desde la app VoxIA Control instalada en el teléfono.';
const NFC_APAGADO = 'El NFC está apagado. Actívalo en los ajustes del teléfono para escanear.';
const SIN_RESPUESTA =
  'La app del teléfono no respondió. Ciérrala y vuelve a abrirla antes de seguir la ronda.';

/**
 * POST /geo/permission con la sesión del guardia (#275). Lanza si no es 2xx
 * para que `reportarPermisoUbicacion` lo cuente como reporte rechazado.
 */
async function reportarPermisoAlServidor(
  apiUrl: string,
  status: 'concedido' | 'solo_primer_plano' | 'denegado' | 'no_disponible',
  deviceInfo: string,
): Promise<void> {
  const respuesta = await fetch(`${apiUrl}/geo/permission`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status, deviceInfo }),
  });
  if (!respuesta.ok) {
    throw new Error(`HTTP ${respuesta.status}`);
  }
}

/**
 * MINOR del protocolo que trajo `qr.scan.start` (#226). Pedirlo a un shell
 * anterior no da error: el shell descarta el mensaje por tipo desconocido y el
 * portal se queda esperando hasta el timeout, con la ronda detenida. Por eso el
 * respaldo por QR solo se ofrece cuando el `ready` anuncia este minor.
 */
const MINOR_CON_QR = 4;

/** MINOR que trajo la familia `track.*` (traza en vivo, #280). */
const MINOR_CON_TRAZA = 5;

export type FasePuente = 'conectando' | 'sin-puente' | 'listo' | 'incompatible';

export interface PuenteGuardia {
  fase: FasePuente;
  /** `true` solo cuando el shell saludó y el equipo tiene antena. */
  puedeEscanear: boolean;
  /**
   * `true` cuando el shell sabe leer QR y el equipo tiene camara (#227). Es
   * capacidad del TELEFONO: si la empresa permite o no el respaldo lo decide la
   * regla `allowQrFallback`, y eso lo cruza `guard-escaneo-modelo.ts`.
   */
  puedeEscanearQr: boolean;
  /** El equipo no trae antena NFC. Sin QR, este guardia no puede marcar puntos. */
  sinAntenaNfc: boolean;
  /** Texto listo para mostrar. En 'incompatible' lo redacta el shell, no el portal. */
  aviso?: string;
  conexion: EstadoConexionPayload;
  escanear: (titulo: string) => Promise<ResultadoEscaneoPayload>;
  escanearQr: (titulo: string) => Promise<ResultadoEscaneoQrPayload>;
  cancelarEscaneo: () => void;
  cancelarEscaneoQr: () => void;
  guardarRutaOffline: (ruta: RutaOfflinePayload) => Promise<boolean>;
  /**
   * Traza en vivo (#280). `soportaTraza` es capacidad del SHELL (minor >= 5):
   * con un shell viejo los metodos no hacen nada y no hay error — la traza
   * degrada en silencio, igual que el QR en su dia.
   */
  soportaTraza: boolean;
  iniciarTraza: (intervalSeconds: number) => void;
  detenerTraza: () => void;
  alPuntoDeTraza: (fn: (punto: PuntoDeTrazaPayload) => void) => () => void;
}

export function useGuardBridge(apiUrl?: string): PuenteGuardia {
  // `useState` y no `useMemo`: la identidad del cliente tiene que sobrevivir a
  // cualquier re-render, y useMemo no lo garantiza por contrato.
  const [cliente] = useState(crearClientePuente);
  const [fase, setFase] = useState<FasePuente>('conectando');
  const [aviso, setAviso] = useState<string>();
  const [puedeEscanear, setPuedeEscanear] = useState(false);
  const [puedeEscanearQr, setPuedeEscanearQr] = useState(false);
  const [soportaTraza, setSoportaTraza] = useState(false);
  const [sinAntenaNfc, setSinAntenaNfc] = useState(false);
  const [soportaRutaOffline, setSoportaRutaOffline] = useState(false);
  // Marca del EQUIPO (api de Android + version de la app), sin datos de la
  // persona. Doble uso: viaja como deviceInfo en el reporte del permiso de
  // ubicacion (#275) y su presencia le dice al efecto de abajo que el saludo
  // ya paso.
  const [infoEquipo, setInfoEquipo] = useState<string>();
  // Valor fijo en el primer render: leer `navigator` acá rompería la hidratación.
  const [conexion, setConexion] = useState<EstadoConexionPayload>({
    enLinea: true,
    tipo: 'desconocida',
  });

  useEffect(() => {
    let cancelado = false;

    const bajaConexion = cliente.alCambiarConexion((estado) => {
      if (!cancelado) setConexion(estado);
    });

    void (async () => {
      const estado = await cliente.conectar().catch(() => undefined);
      if (cancelado) return;

      if (!estado) {
        setFase('sin-puente');
        setAviso(SIN_RESPUESTA);
        return;
      }
      if (estado.clase === 'sin-puente') {
        setFase('sin-puente');
        setAviso(SIN_PUENTE);
        return;
      }
      if (estado.clase === 'incompatible') {
        setFase('incompatible');
        setAviso(estado.info.mensaje);
        return;
      }

      setFase('listo');
      setSoportaRutaOffline(estado.info.protocolo.minor >= 1);
      const { dispositivo } = estado.info;

      /*
       * Las capacidades se publican ANTES de mirar la antena. Antes de #227 un
       * teléfono sin NFC salía por un `return` acá mismo: se quedaba sin firma
       * de dispositivo, sin el estado de conexión que empuja el shell y —lo
       * peor— sin ningún camino para marcar un punto, mirando un botón que no
       * respondía.
       */
      setSinAntenaNfc(!dispositivo.tieneNfc);
      setPuedeEscanearQr(estado.info.protocolo.minor >= MINOR_CON_QR && dispositivo.tieneCamara);
      setSoportaTraza(estado.info.protocolo.minor >= MINOR_CON_TRAZA);

      if (estado.info.protocolo.minor >= 3 && apiUrl && typeof window !== 'undefined') {
        try {
          await cliente.registrarFirma({
            apiUrl: new URL(apiUrl, window.location.origin).href.replace(/\/$/, ''),
            portalOrigin: window.location.origin,
          });
        } catch {
          setAviso('No se pudo registrar la identidad segura de este teléfono. Revisa la conexión.');
          return;
        }
      }

      /*
       * El cable de #275: el servidor exige saber como quedo el permiso de
       * ubicacion del sistema ANTES de dejar iniciar la ronda, y no tiene forma
       * de averiguarlo solo. Aca solo se CONSULTA (permission.query, sin
       * dialogos) y se reporta lo que haya — concedido, denegado o no
       * disponible, todo es dato. El permission.request, que si puede abrir el
       * dialogo del sistema, vive en el efecto del consentimiento: el dialogo
       * de Android solo puede aparecer despues de la divulgacion destacada.
       *
       * Sin await y con fallo blando: un reporte caido no puede detener la
       * conexion del puente ni la ronda. La proxima carga lo reintenta.
       */
      const marcaEquipo =
        `android api ${dispositivo.nivelApiAndroid} · app ${estado.info.app.version}`;
      setInfoEquipo(marcaEquipo);
      if (apiUrl) {
        void reportarPermisoUbicacion({
          consultar: (permiso) => cliente.consultarPermiso(permiso),
          reportar: (estadoApi, deviceInfo) => reportarPermisoAlServidor(apiUrl, estadoApi, deviceInfo),
          deviceInfo: marcaEquipo,
        });
      }
      // Con la antena apagada se deja intentar igual: el shell responde
      // 'nfc-desactivado' y ese mensaje es más útil que un botón muerto. Sin
      // antena no hay aviso acá: el texto depende de si la empresa permite el
      // respaldo por QR, y eso lo redacta `guard-escaneo-modelo.ts`.
      if (dispositivo.tieneNfc) {
        setAviso(dispositivo.nfcActivado ? undefined : NFC_APAGADO);
        setPuedeEscanear(true);
      }

      const conectividad = await cliente.estadoConexion().catch(() => undefined);
      if (conectividad && !cancelado) setConexion(conectividad);
    })();

    return () => {
      cancelado = true;
      bajaConexion();
      cliente.desconectar();
    };
  }, [apiUrl, cliente]);

  /*
   * La otra mitad de #275: cuando el guardia ACABA de aceptar el aviso de
   * geolocalización, ese es el único momento en que corresponde el
   * `permission.request` — la divulgación destacada que Google Play exige
   * antes del diálogo del sistema acaba de mostrarse y aceptarse. El flujo de
   * consentimiento lo anuncia con un evento del DOM para no acoplar tres capas
   * de componentes a un asunto de permisos.
   *
   * El resultado se reporta SIEMPRE, también "denegado": que un guardia no
   * comparta ubicación es un dato que el supervisor necesita, no un fallo.
   */
  useEffect(() => {
    if (fase !== 'listo' || !apiUrl || !infoEquipo || typeof window === 'undefined') {
      return undefined;
    }
    const alAceptarElAviso = () => {
      void (async () => {
        try {
          const resultado = await cliente.pedirPermiso('ubicacion', true);
          await reportarPermisoAlServidor(
            apiUrl,
            traducirEstadoPermiso(resultado.estado),
            infoEquipo,
          );
        } catch {
          // Sin puente o reporte caído: la próxima carga de la pantalla lo
          // reintenta por la vía de la consulta. No hay nada útil que mostrar
          // encima de la confirmación del consentimiento.
        }
      })();
    };
    window.addEventListener(EVENTO_CONSENTIMIENTO_ACEPTADO, alAceptarElAviso);
    return () => window.removeEventListener(EVENTO_CONSENTIMIENTO_ACEPTADO, alAceptarElAviso);
  }, [fase, apiUrl, infoEquipo, cliente]);

  // Sin shell nativo la conectividad la reporta el navegador. Con shell manda el
  // shell, que además avisa los cambios sin que se los pidan.
  useEffect(() => {
    if (fase === 'listo' || typeof window === 'undefined') return undefined;

    const leer = () => setConexion({ enLinea: navigator.onLine, tipo: 'desconocida' });
    leer();
    window.addEventListener('online', leer);
    window.addEventListener('offline', leer);
    return () => {
      window.removeEventListener('online', leer);
      window.removeEventListener('offline', leer);
    };
  }, [fase]);

  const escanear = useCallback(
    (titulo: string) => cliente.escanearNfc({ titulo }),
    [cliente],
  );
  const escanearQr = useCallback(
    (titulo: string) => cliente.escanearQr({ titulo }),
    [cliente],
  );
  const cancelarEscaneo = useCallback(() => cliente.cancelarEscaneo(), [cliente]);
  const cancelarEscaneoQr = useCallback(() => cliente.cancelarEscaneoQr(), [cliente]);
  const guardarRutaOffline = useCallback(async (ruta: RutaOfflinePayload) => {
    if (!soportaRutaOffline) return false;
    await cliente.guardarRutaOffline(ruta);
    return true;
  }, [cliente, soportaRutaOffline]);

  return {
    fase,
    puedeEscanear,
    puedeEscanearQr,
    sinAntenaNfc,
    ...(aviso ? { aviso } : {}),
    conexion,
    escanear,
    escanearQr,
    cancelarEscaneo,
    cancelarEscaneoQr,
    guardarRutaOffline,
    soportaTraza,
    iniciarTraza: cliente.iniciarTraza,
    detenerTraza: cliente.detenerTraza,
    alPuntoDeTraza: cliente.alPuntoDeTraza,
  };
}
