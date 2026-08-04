import { Camera, CameraView } from 'expo-camera';
import * as Location from 'expo-location';
import * as Network from 'expo-network';
import { Platform } from 'react-native';

import { ErrorEscaneo, type ManejadoresNativos } from './native';
import type {
  EstadoConexionPayload,
  EstadoPermiso,
  Permiso,
  ResultadoPermisoPayload,
} from './protocol';

interface RespuestaPermiso { status: string; canAskAgain: boolean }

function resultadoPermiso(permiso: Permiso, respuesta: RespuestaPermiso): ResultadoPermisoPayload {
  let estado: EstadoPermiso = 'denegado';
  if (respuesta.status === 'granted') estado = 'concedido';
  else if (!respuesta.canAskAgain) estado = 'denegado-definitivo';
  return { permiso, estado, puedeVolverAPedir: respuesta.canAskAgain };
}

function noAplica(permiso: Permiso): ResultadoPermisoPayload {
  return { permiso, estado: 'no-aplica', puedeVolverAPedir: false };
}

export function normalizarConexion(estado: Network.NetworkState): EstadoConexionPayload {
  const enLinea = estado.isConnected === true && estado.isInternetReachable !== false;
  if (!enLinea) return { enLinea: false, tipo: 'ninguna' };
  if (estado.type === Network.NetworkStateType.WIFI) return { enLinea: true, tipo: 'wifi' };
  if (estado.type === Network.NetworkStateType.CELLULAR) {
    return { enLinea: true, tipo: 'celular' };
  }
  return { enLinea: true, tipo: 'desconocida' };
}

async function permiso(permisoSolicitado: Permiso, pedir: boolean) {
  switch (permisoSolicitado) {
    case 'camara':
      return resultadoPermiso(
        permisoSolicitado,
        await (pedir ? Camera.requestCameraPermissionsAsync() : Camera.getCameraPermissionsAsync()),
      );
    case 'ubicacion':
      return resultadoPermiso(
        permisoSolicitado,
        await (pedir
          ? Location.requestForegroundPermissionsAsync()
          : Location.getForegroundPermissionsAsync()),
      );
    case 'ubicacion-segundo-plano':
      return resultadoPermiso(
        permisoSolicitado,
        await (pedir
          ? Location.requestBackgroundPermissionsAsync()
          : Location.getBackgroundPermissionsAsync()),
      );
    // NFC no tiene permiso runtime en Android. Notificaciones se conecta al
    // proveedor que el equipo elija; mentir con "concedido" sería peor.
    case 'nfc':
    case 'notificaciones':
      return noAplica(permisoSolicitado);
  }
}

/**
 * Manejadores seguros antes de integrar el lector (#57). El puente queda
 * operativo sin fingir que existe una antena: #57 sustituye solo ese puerto.
 */
export function crearManejadoresBase(): ManejadoresNativos {
  return {
    capacidades: async () => ({
      tieneNfc: false,
      nfcActivado: false,
      // `CameraView.isAvailableAsync()` es SOLO web (expo-camera lo marca
      // @platform web): en Android no existe y la llamada tumba el puente
      // entero al primer `capacidades`, que es lo primero que pide el WebView.
      //
      // En Android damos la camara por presente: un telefono de trabajo sin
      // camara no puede ejecutar una ronda con evidencia, y si por algun caso
      // faltara, la captura falla despues con su propio error entendible en vez
      // de dejar la app sin puente desde el arranque.
      tieneCamara: Platform.OS === 'web' ? await CameraView.isAvailableAsync() : true,
      nivelApiAndroid: typeof Platform.Version === 'number' ? Platform.Version : 0,
    }),
    escanearNfc: async () => {
      throw new ErrorEscaneo(
        'nfc-no-disponible',
        'El lector NFC todavía no está disponible. Usa el respaldo QR.',
        false,
      );
    },
    cancelarEscaneo: () => undefined,
    pedirPermiso: (permisoSolicitado) => permiso(permisoSolicitado, true),
    consultarPermiso: (permisoSolicitado) => permiso(permisoSolicitado, false),
    estadoConexion: async () => normalizarConexion(await Network.getNetworkStateAsync()),
    guardarRutaOffline: async () => {
      throw new Error('almacenamiento-offline-no-configurado');
    },
    borrarRutaOffline: async () => undefined,
    encolarSync: async () => false,
    sincronizarCola: async () => ({ procesadas: 0, pendientes: 0 }),
    registrarFirma: async () => {
      throw new Error('firma-no-configurada');
    },
  };
}
