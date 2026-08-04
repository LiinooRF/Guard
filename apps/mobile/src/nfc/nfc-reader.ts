import { ErrorEscaneo } from '../bridge/native';
import type { ResultadoEscaneoPayload } from '../bridge/protocol';

export interface EtiquetaNfc {
  readonly id?: string;
}

export interface PosicionEscaneo {
  readonly latitude: number;
  readonly longitude: number;
  readonly accuracyM?: number;
}

export type FalloNfcNativo =
  | 'radio-apagada'
  | 'cancelado'
  | 'timeout'
  | 'conexion-perdida'
  | 'ocupado'
  | 'desconocido';

export interface PuertoNfc {
  readonly iniciar: () => Promise<void>;
  readonly soportado: () => Promise<boolean>;
  readonly activado: () => Promise<boolean>;
  readonly esperarEtiqueta: () => Promise<EtiquetaNfc | null>;
  readonly cancelar: () => Promise<void>;
  readonly posicion: () => Promise<PosicionEscaneo | undefined>;
  readonly confirmar: () => void;
  readonly clasificarError: (causa: unknown) => FalloNfcNativo;
  readonly ahora?: () => Date;
}

export interface LectorNfc {
  readonly capacidades: () => Promise<{ tieneNfc: boolean; nfcActivado: boolean }>;
  readonly escanear: (timeoutMs: number) => Promise<ResultadoEscaneoPayload>;
  readonly cancelar: () => void;
}

function normalizarUid(id: string | undefined): string | undefined {
  const uid = id?.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return uid && uid.length >= 8 && uid.length <= 64 && uid.length % 2 === 0 ? uid : undefined;
}

function errorClasificado(fallo: FalloNfcNativo): ErrorEscaneo {
  switch (fallo) {
    case 'radio-apagada':
      return new ErrorEscaneo('nfc-desactivado', 'El NFC está apagado. Actívalo en Ajustes.', false);
    case 'cancelado':
      return new ErrorEscaneo('cancelado', 'Escaneo cancelado.', false);
    case 'timeout':
      return new ErrorEscaneo('timeout', 'No se detectó una etiqueta. Vuelve a intentarlo.', true);
    case 'conexion-perdida':
      return new ErrorEscaneo('etiqueta-ilegible', 'No se pudo leer la etiqueta. Acerca nuevamente el teléfono.', true);
    case 'ocupado':
      return new ErrorEscaneo('error-desconocido', 'El lector NFC está ocupado. Espera un momento.', true);
    default:
      return new ErrorEscaneo('error-desconocido', 'No se pudo iniciar el lector NFC.', true);
  }
}

export function crearLectorNfc(puerto: PuertoNfc): LectorNfc {
  let inicio: Promise<void> | undefined;
  let escaneoActivo = false;
  let cancelado = false;

  const iniciar = () => (inicio ??= puerto.iniciar());

  async function capacidades() {
    await iniciar();
    const tieneNfc = await puerto.soportado();
    return { tieneNfc, nfcActivado: tieneNfc && await puerto.activado() };
  }

  async function escanear(timeoutMs: number): Promise<ResultadoEscaneoPayload> {
    if (escaneoActivo) throw errorClasificado('ocupado');
    escaneoActivo = true;
    cancelado = false;
    let temporizador: ReturnType<typeof setTimeout> | undefined;

    try {
      const estado = await capacidades();
      if (!estado.tieneNfc) {
        throw new ErrorEscaneo('nfc-no-disponible', 'Este teléfono no tiene NFC. Usa el respaldo QR.', false);
      }
      if (!estado.nfcActivado) throw errorClasificado('radio-apagada');

      const vencimiento = new Promise<never>((_, rechazar) => {
        temporizador = setTimeout(() => rechazar(errorClasificado('timeout')), timeoutMs);
      });
      const etiqueta = await Promise.race([puerto.esperarEtiqueta(), vencimiento]);
      if (cancelado) throw errorClasificado('cancelado');

      const uid = normalizarUid(etiqueta?.id);
      if (!uid) {
        throw new ErrorEscaneo('etiqueta-ilegible', 'La etiqueta no entregó un identificador válido.', true);
      }

      // La confirmación ocurre inmediatamente después de validar el UID. Android
      // conserva además su sonido de descubrimiento NFC (no usamos NO_PLATFORM_SOUNDS).
      puerto.confirmar();
      const scannedAt = (puerto.ahora?.() ?? new Date()).toISOString();
      const posicion = await puerto.posicion().catch(() => undefined);
      return {
        uid,
        tech: 'nfc',
        scannedAt,
        ...(posicion ?? {}),
      };
    } catch (causa) {
      if (causa instanceof ErrorEscaneo) throw causa;
      throw errorClasificado(cancelado ? 'cancelado' : puerto.clasificarError(causa));
    } finally {
      if (temporizador) clearTimeout(temporizador);
      await puerto.cancelar().catch(() => undefined);
      escaneoActivo = false;
    }
  }

  function cancelar() {
    cancelado = true;
    void puerto.cancelar().catch(() => undefined);
  }

  return { capacidades, escanear, cancelar };
}
