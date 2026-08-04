import * as Location from 'expo-location';
import { Vibration } from 'react-native';
import NfcManager, { NfcError, NfcTech } from 'react-native-nfc-manager';

import type { FalloNfcNativo, PuertoNfc } from './nfc-reader';

function clasificarError(causa: unknown): FalloNfcNativo {
  if (causa instanceof NfcError.RadioDisabled) return 'radio-apagada';
  if (causa instanceof NfcError.UserCancel) return 'cancelado';
  if (causa instanceof NfcError.Timeout) return 'timeout';
  if (causa instanceof NfcError.TagConnectionLost || causa instanceof NfcError.TagNotConnected) {
    return 'conexion-perdida';
  }
  if (causa instanceof NfcError.SystemBusy) return 'ocupado';
  return 'desconocido';
}

export const puertoNfcAndroid: PuertoNfc = {
  iniciar: () => NfcManager.start(),
  soportado: () => NfcManager.isSupported(),
  activado: () => NfcManager.isEnabled(),
  esperarEtiqueta: async () => {
    // NTAG puede venir formateada como NDEF o en blanco. Pedir las tres
    // tecnologías evita rechazar una etiqueta válida solo por su formato.
    await NfcManager.requestTechnology(
      [NfcTech.Ndef, NfcTech.NfcA, NfcTech.MifareUltralight],
      { isReaderModeEnabled: true },
    );
    return NfcManager.getTag();
  },
  cancelar: () => NfcManager.cancelTechnologyRequest({ throwOnError: false }),
  posicion: async () => {
    const permiso = await Location.getForegroundPermissionsAsync();
    if (permiso.status !== 'granted') return undefined;
    const posicion = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
      mayShowUserSettingsDialog: true,
    });
    return {
      latitude: posicion.coords.latitude,
      longitude: posicion.coords.longitude,
      ...(posicion.coords.accuracy === null ? {} : { accuracyM: posicion.coords.accuracy }),
    };
  },
  confirmar: () => Vibration.vibrate(80),
  clasificarError,
};
