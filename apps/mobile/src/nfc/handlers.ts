import { CameraView } from 'expo-camera';
import { Platform } from 'react-native';

import { crearManejadoresBase } from '../bridge/default-handlers';
import type { ManejadoresNativos } from '../bridge/native';
import { crearLectorNfc, type PuertoNfc } from './nfc-reader';
import { borrarRutaOffline, guardarRutaOffline } from '../offline/route-store';
import { borrarColaSync, encolarOperacion, sincronizarCola } from '../offline/sync-queue';
import { registrarClaveDispositivo } from '../security/device-signature';

export function crearManejadoresNfc(puerto: PuertoNfc): ManejadoresNativos {
  const base = crearManejadoresBase();
  const lector = crearLectorNfc(puerto);
  return {
    ...base,
    capacidades: async () => ({
      ...await lector.capacidades(),
      tieneCamara: await CameraView.isAvailableAsync(),
      nivelApiAndroid: typeof Platform.Version === 'number' ? Platform.Version : 0,
    }),
    escanearNfc: ({ timeoutMs }) => lector.escanear(timeoutMs),
    cancelarEscaneo: lector.cancelar,
    guardarRutaOffline,
    borrarRutaOffline: async () => {
      await borrarRutaOffline();
      await borrarColaSync();
    },
    encolarSync: encolarOperacion,
    sincronizarCola,
    registrarFirma: ({ apiUrl, portalOrigin }) =>
      registrarClaveDispositivo(apiUrl, portalOrigin),
  };
}
