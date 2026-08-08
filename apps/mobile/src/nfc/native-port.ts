import { Vibration } from 'react-native';
import NfcManager, { NfcAdapter, NfcError, NfcTech } from 'react-native-nfc-manager';

import type { FalloNfcNativo, PuertoNfc } from './nfc-reader';
import { posicionDelEscaneo } from '../geo/posicion';
import { firmarEscaneo } from '../security/device-signature';

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

/**
 * Que familias de etiquetas escucha el modo lector de Android.
 *
 * **Sin esto el escaneo NO funciona, y falla del peor modo posible: en
 * silencio.** `requestTechnology(..., { isReaderModeEnabled: true })` deja
 * `readerModeFlags` en su valor por defecto, que es `0` (react-native-nfc-manager
 * 3.17.2, src/NfcManager.js:44). Con cero banderas el modo lector se enciende
 * sin escuchar NINGUNA familia: la etiqueta nunca llega a la app, y como el
 * modo lector tampoco bloquea el despacho del sistema, Android abre su propio
 * visor de etiquetas encima de la ronda. Medido en un moto g35:
 *
 *     enableReaderMode, flags: 0
 *     Input focus -> com.google.android.tag/TagViewer
 *
 * Se piden las cuatro familias, no solo NfcA. Las etiquetas de un recinto las
 * compra el cliente, no nosotros: si aparece un lote ISO 15693 (NfcV), que es
 * comun en control de accesos, con solo NfcA el guardia no podria marcar y
 * nadie sabria por que.
 */
const FAMILIAS_QUE_ESCUCHA =
  NfcAdapter.FLAG_READER_NFC_A |
  NfcAdapter.FLAG_READER_NFC_B |
  NfcAdapter.FLAG_READER_NFC_F |
  NfcAdapter.FLAG_READER_NFC_V;

export const puertoNfcAndroid: PuertoNfc = {
  iniciar: () => NfcManager.start(),
  soportado: () => NfcManager.isSupported(),
  activado: () => NfcManager.isEnabled(),
  esperarEtiqueta: async () => {
    // NTAG puede venir formateada como NDEF o en blanco. Pedir las tres
    // tecnologías evita rechazar una etiqueta válida solo por su formato.
    await NfcManager.requestTechnology(
      [NfcTech.Ndef, NfcTech.NfcA, NfcTech.MifareUltralight],
      { isReaderModeEnabled: true, readerModeFlags: FAMILIAS_QUE_ESCUCHA },
    );
    return NfcManager.getTag();
  },
  cancelar: () => NfcManager.cancelTechnologyRequest({ throwOnError: false }),
  // Misma lectura de GPS que el respaldo por QR: las anomalias que calcula el
  // servidor tienen que salir del mismo dato, no de dos copias que se separen.
  posicion: posicionDelEscaneo,
  confirmar: () => Vibration.vibrate(80),
  firmar: firmarEscaneo,
  clasificarError,
};
