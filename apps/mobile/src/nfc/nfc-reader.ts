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
  readonly firmar: (input: {
    uid: string; method: 'nfc'; scannedAt: string;
    latitude?: number; longitude?: number; accuracyM?: number;
  }) => Promise<{
    clientScanId: string; deviceId: string; signature: string;
  }>;
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

  /**
   * Cuanto se espera a que el NFC del sistema conteste antes de darlo por
   * ausente. Comprobado en un telefono real: cuando `NfcManager.start()` no
   * resuelve, el saludo del puente NUNCA se responde — y como el portal
   * deshabilita el escaneo hasta recibir `ready`, el guardia se queda sin poder
   * hacer nada. Ni siquiera por QR, que es justo el respaldo que existe para
   * los telefonos sin antena.
   *
   * Tres segundos: consultar el estado del NFC es una llamada local al sistema.
   * Si tarda mas, no va a mejorar esperando.
   */
  const MS_ESPERA_NFC = 3_000;

  async function conTope<T>(promesa: Promise<T>, alVencer: T): Promise<T> {
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promesa,
        new Promise<T>((resolver) => {
          temporizador = setTimeout(() => resolver(alVencer), MS_ESPERA_NFC);
        }),
      ]);
    } finally {
      if (temporizador) clearTimeout(temporizador);
    }
  }

  /**
   * Nunca se cuelga y nunca lanza: un telefono sin NFC, con el NFC apagado o
   * con la pila del sistema colgada tiene que quedar como `tieneNfc: false`,
   * no como un puente que no contesta. La diferencia entre las dos es que en la
   * primera el guardia trabaja por QR, y en la segunda no trabaja.
   */
  async function capacidades() {
    const arrancado = await conTope(iniciar().then(() => true).catch(() => false), false);
    if (!arrancado) return { tieneNfc: false, nfcActivado: false };
    const tieneNfc = await conTope(puerto.soportado().catch(() => false), false);
    if (!tieneNfc) return { tieneNfc: false, nfcActivado: false };
    return { tieneNfc, nfcActivado: await conTope(puerto.activado().catch(() => false), false) };
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
      const scan = {
        uid,
        scannedAt,
        ...(posicion ?? {}),
      };
      const firma = await puerto.firmar({ ...scan, method: 'nfc' });
      return { ...scan, tech: 'nfc', ...firma };
    } catch (causa) {
      if (causa instanceof ErrorEscaneo) throw causa;
      const clase = cancelado ? 'cancelado' : puerto.clasificarError(causa);
      const error = errorClasificado(clase);
      /*
       * `clasificarError` reduce cualquier fallo a una de seis frases, y la
       * sexta —"No se pudo iniciar el lector NFC"— es un cajon de sastre que no
       * dice nada. En un telefono real eso convierte cada intento en una
       * teoria: ¿fallo la conexion con la etiqueta, el GPS, la firma del
       * dispositivo? Se ven todas igual.
       *
       * En compilaciones de prueba (`EXPO_PUBLIC_DEPURABLE`, el mismo
       * interruptor que abre DevTools) se agrega el motivo tecnico. En
       * produccion el guardia ve la frase limpia.
       */
      if (clase === 'desconocido' && process.env.EXPO_PUBLIC_DEPURABLE === '1') {
        const motivo = causa instanceof Error ? causa.message : String(causa);
        throw new ErrorEscaneo(error.codigo, `${error.message} [${motivo}]`, error.reintentable);
      }
      throw error;
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
