import { CameraView } from 'expo-camera';
import { Platform } from 'react-native';

import { crearManejadoresBase } from '../bridge/default-handlers';
import type { ManejadoresNativos } from '../bridge/native';
import { crearLectorNfc, type PuertoNfc } from './nfc-reader';
import { borrarRutaOffline, guardarRutaOffline } from '../offline/route-store';
import { borrarColaSync, encolarOperacion, sincronizarCola } from '../offline/sync-queue';
import type { LectorQr } from '../qr/qr-reader';
import { registrarClaveDispositivo } from '../security/device-signature';

/**
 * Manejadores reales del shell: etiqueta NFC (#57) y respaldo por camara (#226).
 *
 * El lector de QR entra por parametro y NO es opcional a proposito. Si lo fuera,
 * olvidar el cable en `App.tsx` compilaria igual y el shell anunciaria el minor 4
 * —o sea, "se leer QR"— para despues fallar con `camara-no-disponible` con el
 * guardia parado frente al punto. Obligatorio, ese olvido no compila.
 */
export function crearManejadoresNfc(puerto: PuertoNfc, lectorQr: LectorQr): ManejadoresNativos {
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
    escanearQr: ({ timeoutMs, titulo }) => lectorQr.escanear(timeoutMs, titulo),
    cancelarEscaneoQr: lectorQr.cancelar,
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
