'use client';

import { useCallback, useEffect, useState } from 'react';

import type {
  EstadoConexionPayload,
  ResultadoEscaneoPayload,
  RutaOfflinePayload,
} from '../_lib/bridge/protocol';
import { crearClientePuente } from '../_lib/bridge/web-client';

export { ErrorEscaneoPortal } from '../_lib/bridge/web-client';
export type { ResultadoEscaneoPayload } from '../_lib/bridge/protocol';

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
const SIN_ANTENA =
  'Este teléfono no tiene antena NFC y no puede registrar puntos. Avisa a tu supervisor.';
const NFC_APAGADO = 'El NFC está apagado. Actívalo en los ajustes del teléfono para escanear.';
const SIN_RESPUESTA =
  'La app del teléfono no respondió. Ciérrala y vuelve a abrirla antes de seguir la ronda.';

export type FasePuente = 'conectando' | 'sin-puente' | 'listo' | 'incompatible';

export interface PuenteGuardia {
  fase: FasePuente;
  /** `true` solo cuando el shell saludó y el equipo tiene antena. */
  puedeEscanear: boolean;
  /** Texto listo para mostrar. En 'incompatible' lo redacta el shell, no el portal. */
  aviso?: string;
  conexion: EstadoConexionPayload;
  escanear: (titulo: string) => Promise<ResultadoEscaneoPayload>;
  cancelarEscaneo: () => void;
  guardarRutaOffline: (ruta: RutaOfflinePayload) => Promise<boolean>;
}

export function useGuardBridge(apiUrl?: string): PuenteGuardia {
  // `useState` y no `useMemo`: la identidad del cliente tiene que sobrevivir a
  // cualquier re-render, y useMemo no lo garantiza por contrato.
  const [cliente] = useState(crearClientePuente);
  const [fase, setFase] = useState<FasePuente>('conectando');
  const [aviso, setAviso] = useState<string>();
  const [puedeEscanear, setPuedeEscanear] = useState(false);
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
      if (!dispositivo.tieneNfc) {
        setAviso(SIN_ANTENA);
        return;
      }
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
      // 'nfc-desactivado' y ese mensaje es más útil que un botón muerto.
      setAviso(dispositivo.nfcActivado ? undefined : NFC_APAGADO);
      setPuedeEscanear(true);

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
  const cancelarEscaneo = useCallback(() => cliente.cancelarEscaneo(), [cliente]);
  const guardarRutaOffline = useCallback(async (ruta: RutaOfflinePayload) => {
    if (!soportaRutaOffline) return false;
    await cliente.guardarRutaOffline(ruta);
    return true;
  }, [cliente, soportaRutaOffline]);

  return {
    fase,
    puedeEscanear,
    ...(aviso ? { aviso } : {}),
    conexion,
    escanear,
    cancelarEscaneo,
    guardarRutaOffline,
  };
}
