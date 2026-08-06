'use client';

import { useCallback, useEffect, useState } from 'react';

import type {
  EstadoConexionPayload,
  ResultadoEscaneoPayload,
  ResultadoEscaneoQrPayload,
  RutaOfflinePayload,
} from '../_lib/bridge/protocol';
import { crearClientePuente } from '../_lib/bridge/web-client';

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
 * MINOR del protocolo que trajo `qr.scan.start` (#226). Pedirlo a un shell
 * anterior no da error: el shell descarta el mensaje por tipo desconocido y el
 * portal se queda esperando hasta el timeout, con la ronda detenida. Por eso el
 * respaldo por QR solo se ofrece cuando el `ready` anuncia este minor.
 */
const MINOR_CON_QR = 4;

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
}

export function useGuardBridge(apiUrl?: string): PuenteGuardia {
  // `useState` y no `useMemo`: la identidad del cliente tiene que sobrevivir a
  // cualquier re-render, y useMemo no lo garantiza por contrato.
  const [cliente] = useState(crearClientePuente);
  const [fase, setFase] = useState<FasePuente>('conectando');
  const [aviso, setAviso] = useState<string>();
  const [puedeEscanear, setPuedeEscanear] = useState(false);
  const [puedeEscanearQr, setPuedeEscanearQr] = useState(false);
  const [sinAntenaNfc, setSinAntenaNfc] = useState(false);
  const [soportaRutaOffline, setSoportaRutaOffline] = useState(false);
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
  };
}
