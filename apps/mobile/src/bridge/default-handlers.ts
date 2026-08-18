import { Camera, CameraView } from 'expo-camera';
import * as Location from 'expo-location';
import * as Network from 'expo-network';
import { PermissionsAndroid, Platform } from 'react-native';

import { detenerTraza, iniciarTraza } from '../geo/traza';
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

/** Desde Android 13 (API 33) `POST_NOTIFICATIONS` se pide con dialogo. */
const ANDROID_NOTIFICACIONES_EXPLICITAS = 33;

/**
 * Permiso de notificaciones.
 *
 * Antes esto devolvia 'no-aplica' y el dialogo NO aparecia nunca: el guardia
 * quedaba sin avisos y nadie se enteraba, porque Android tampoco avisa que los
 * esta ocultando. El sintoma en terreno es el peor posible —el supervisor jura
 * que la app no sirve porque el panico nunca sono—.
 *
 * Se pide con `PermissionsAndroid` a proposito: PEDIR el permiso no necesita
 * proveedor de push ni FCM. La entrega de notificaciones es otra cosa (la
 * epica #174, que esta en M4 y no se trabaja en esta etapa); esto es solo la
 * puerta, y sin ella lo que se construya despues igual no se ve.
 *
 * DOS RECHAZOS Y SE ACABO: Android deja de mostrar el dialogo tras dos
 * negativas y la unica salida pasa a ser Ajustes. Por eso el momento lo elige
 * el portal, con contexto, y no el arranque de la app.
 */
async function permisoDeNotificaciones(pedir: boolean): Promise<ResultadoPermisoPayload> {
  if (Platform.OS !== 'android') return noAplica('notificaciones');
  if (Number(Platform.Version) < ANDROID_NOTIFICACIONES_EXPLICITAS) {
    // Antes de 33 quedaba habilitado al instalar: no hay dialogo que abrir.
    return { permiso: 'notificaciones', estado: 'concedido', puedeVolverAPedir: false };
  }
  const clave = PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS;
  if (!pedir) {
    const tiene = await PermissionsAndroid.check(clave);
    return {
      permiso: 'notificaciones',
      estado: tiene ? 'concedido' : 'denegado',
      puedeVolverAPedir: !tiene,
    };
  }
  const respuesta = await PermissionsAndroid.request(clave);
  if (respuesta === PermissionsAndroid.RESULTS.GRANTED) {
    return { permiso: 'notificaciones', estado: 'concedido', puedeVolverAPedir: false };
  }
  const definitivo = respuesta === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN;
  return {
    permiso: 'notificaciones',
    estado: definitivo ? 'denegado-definitivo' : 'denegado',
    puedeVolverAPedir: !definitivo,
  };
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
    case 'notificaciones':
      return await permisoDeNotificaciones(pedir);
    // NFC no tiene permiso runtime en Android: el sistema lo concede al
    // instalar. 'no-aplica' aca es la verdad, no una excusa.
    case 'nfc':
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
    // Igual que el NFC: el puerto seguro FALLA con un código del contrato en vez
    // de quedarse callado. Un shell que anuncia el minor 4 y no responde a
    // `qr.scan.start` deja al portal esperando el timeout completo, parado
    // frente al punto. Quien monta la cámara de verdad sustituye este puerto
    // (`src/qr/camara.tsx`).
    escanearQr: async () => {
      throw new ErrorEscaneo(
        'camara-no-disponible',
        'Esta versión de la app todavía no puede leer códigos QR. Actualízala desde Google Play.',
        false,
      );
    },
    cancelarEscaneoQr: () => undefined,
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
    // Traza en vivo (#280): tampoco depende de la antena NFC.
    iniciarTraza,
    detenerTraza,
  };
}
