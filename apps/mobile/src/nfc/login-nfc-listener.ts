import { Vibration } from 'react-native';
import NfcManager, { NfcAdapter, NfcError, NfcTech } from 'react-native-nfc-manager';

/**
 * Banderas del modo lector de Android para captura pasiva en Login.
 * FLAG_READER_SKIP_NDEF_CHECK (0x80) omite la comprobación NDEF de sistema,
 * permitiendo lecturas instantáneas (< 20 ms) en credenciales de control de acceso.
 */
const FAMILIAS_QUE_ESCUCHA =
  NfcAdapter.FLAG_READER_NFC_A |
  NfcAdapter.FLAG_READER_NFC_B |
  NfcAdapter.FLAG_READER_NFC_F |
  NfcAdapter.FLAG_READER_NFC_V |
  NfcAdapter.FLAG_READER_SKIP_NDEF_CHECK;

const TECNOLOGIAS_SOPORTADAS = [
  NfcTech.Ndef,
  NfcTech.NfcA,
  NfcTech.MifareUltralight,
  NfcTech.IsoDep,
  NfcTech.NfcV,
  NfcTech.NfcB,
  NfcTech.NfcF,
  NfcTech.MifareClassic,
];

let escuchando = false;
let cancelado = false;
let ultimoUidLeido: string | null = null;
let marcaTiempoUltimaLectura = 0;
const TIEMPO_ANTIREBOTE_MS = 1_500;

function normalizarUid(id: string | undefined): string | undefined {
  const uid = id?.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return uid && uid.length >= 4 && uid.length <= 64 ? uid : undefined;
}

export async function verificarEstadoNfc(): Promise<{ soportado: boolean; activado: boolean }> {
  try {
    await NfcManager.start().catch(() => undefined);
    const soportado = await NfcManager.isSupported().catch(() => false);
    if (!soportado) return { soportado: false, activado: false };
    const activado = await NfcManager.isEnabled().catch(() => false);
    return { soportado: true, activado: Boolean(activado) };
  } catch {
    return { soportado: false, activado: false };
  }
}

export async function abrirAjustesNfc(): Promise<void> {
  try {
    await NfcManager.goToNfcSetting();
  } catch {
    // Si no está disponible el deep link
  }
}

export async function iniciarEscuchaNfcLogin(alDetectarUid: (uid: string) => void): Promise<void> {
  if (escuchando) return;
  escuchando = true;
  cancelado = false;

  try {
    await NfcManager.start().catch(() => undefined);

    while (escuchando && !cancelado) {
      const soportado = await NfcManager.isSupported().catch(() => false);
      if (!soportado) {
        escuchando = false;
        break;
      }
      const activado = await NfcManager.isEnabled().catch(() => false);
      if (!activado) {
        // Pausa breve esperando a que el usuario active NFC sin salir permanentemente
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      try {
        await NfcManager.requestTechnology(TECNOLOGIAS_SOPORTADAS, {
          isReaderModeEnabled: true,
          readerModeFlags: FAMILIAS_QUE_ESCUCHA,
        });

        if (!escuchando || cancelado) break;

        const tag = await NfcManager.getTag();
        const uid = normalizarUid(tag?.id);
        const ahora = Date.now();

        if (uid && escuchando && !cancelado) {
          const esMismoReciente =
            uid === ultimoUidLeido && ahora - marcaTiempoUltimaLectura < TIEMPO_ANTIREBOTE_MS;

          if (!esMismoReciente) {
            ultimoUidLeido = uid;
            marcaTiempoUltimaLectura = ahora;
            Vibration.vibrate(80);
            alDetectarUid(uid);
          }
        }
      } catch (error: unknown) {
        if (!escuchando || cancelado) break;

        if (
          error instanceof NfcError.TagConnectionLost ||
          error instanceof NfcError.TagNotConnected ||
          (error instanceof Error && error.message?.includes('connection lost'))
        ) {
          // Retiro rápido de tarjeta: micro-pausa de 50ms y continuar escuchando
          await new Promise((r) => setTimeout(r, 50));
        } else if (error instanceof NfcError.SystemBusy) {
          await new Promise((r) => setTimeout(r, 200));
        } else {
          await new Promise((r) => setTimeout(r, 150));
        }
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
