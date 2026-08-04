import { CameraView } from 'expo-camera';
import { Platform } from 'react-native';

import { crearManejadoresBase } from '../bridge/default-handlers';
import type { ManejadoresNativos } from '../bridge/native';
import { crearLectorNfc, type PuertoNfc } from './nfc-reader';

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
  };
}

