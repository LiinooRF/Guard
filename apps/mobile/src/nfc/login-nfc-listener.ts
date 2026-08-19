import { Vibration } from 'react-native';
import NfcManager, { NfcAdapter, NfcTech } from 'react-native-nfc-manager';

const FAMILIAS_QUE_ESCUCHA =
  NfcAdapter.FLAG_READER_NFC_A |
  NfcAdapter.FLAG_READER_NFC_B |
  NfcAdapter.FLAG_READER_NFC_F |
  NfcAdapter.FLAG_READER_NFC_V;

let escuchando = false;
let cancelado = false;

function normalizarUid(id: string | undefined): string | undefined {
  const uid = id?.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return uid && uid.length >= 4 && uid.length <= 64 ? uid : undefined;
}

export async function iniciarEscuchaNfcLogin(alDetectarUid: (uid: string) => void): Promise<void> {
  if (escuchando) return;
  escuchando = true;
  cancelado = false;

  try {
    await NfcManager.start().catch(() => undefined);
    const soportado = await NfcManager.isSupported().catch(() => false);
    const activado = await NfcManager.isEnabled().catch(() => false);
    if (!soportado || !activado) {
      escuchando = false;
      return;
    }

    while (escuchando && !cancelado) {
      try {
        await NfcManager.requestTechnology(
          [NfcTech.Ndef, NfcTech.NfcA, NfcTech.MifareUltralight],
          { isReaderModeEnabled: true, readerModeFlags: FAMILIAS_QUE_ESCUCHA },
        );
        const tag = await NfcManager.getTag();
        const uid = normalizarUid(tag?.id);
        if (uid && escuchando && !cancelado) {
          Vibration.vibrate(80);
          alDetectarUid(uid);
          // Pausa breve para evitar disparos múltiples por la misma lectura
          await new Promise((r) => setTimeout(r, 1500));
        }
      } catch {
        // En caso de cancelación o micro-corte de lectura, pausar antes de reintentar
        await new Promise((r) => setTimeout(r, 400));
      } finally {
        await NfcManager.cancelTechnologyRequest({ throwOnError: false }).catch(() => undefined);
      }
    }
  } finally {
    escuchando = false;
  }
}

export function detenerEscuchaNfcLogin(): void {
  escuchando = false;
  cancelado = true;
  void NfcManager.cancelTechnologyRequest({ throwOnError: false }).catch(() => undefined);
}
