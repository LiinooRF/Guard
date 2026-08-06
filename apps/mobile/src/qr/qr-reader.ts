import { ErrorEscaneo } from '../bridge/native';
import { esCodigoQrDePunto, type ResultadoEscaneoQrPayload } from '../bridge/protocol';
import type { PosicionEscaneo } from '../nfc/nfc-reader';

/**
 * Lector del QR de respaldo (#226), gemelo de `nfc-reader.ts` y con la misma
 * forma a proposito: puerto inyectado, error tipado y cancelacion que siempre
 * libera el recurso. Lo unico que cambia es el recurso — camara en vez de
 * antena— y eso ordena las diferencias que si importan:
 *
 * 1. La camara SE VE. Una antena que queda encendida gasta bateria; una camara
 *    que queda encendida se queda encima de la pantalla del guardia y le tapa la
 *    ronda. Por eso `cerrarCamara()` va en el `finally` y tambien en `cancelar`.
 * 2. Al lado del punto hay otros codigos —un afiche, una promocion, el QR del
 *    wifi— y ninguno debe cortar el escaneo. Los que no son del producto se
 *    descartan y la camara SIGUE mirando hasta el plazo.
 * 3. `expo-camera` funciona en Expo Go y `react-native-nfc-manager` no. Este
 *    archivo es lo que hace que una ronda completa se pueda ejecutar sin
 *    compilar un APK, que es el punto de #217.
 */

export interface PuertoQr {
  /** Estado del permiso de camara, pidiendolo al usuario si hace falta. */
  readonly permisoCamara: () => Promise<'concedido' | 'denegado' | 'denegado-definitivo'>;
  /** Enciende la vista previa. El titulo se muestra sobre la camara. */
  readonly abrirCamara: (titulo?: string) => void;
  /**
   * Apaga la vista previa. Tiene que ser idempotente —se llama de mas— y tiene
   * que hacer FALLAR cualquier `esperarCodigo()` pendiente: si lo deja colgado,
   * el escaneo cancelado nunca termina y el boton se queda ocupado para siempre.
   */
  readonly cerrarCamara: () => void;
  /** Resuelve con el texto del proximo codigo que entre al cuadro. */
  readonly esperarCodigo: () => Promise<string>;
  readonly posicion: () => Promise<PosicionEscaneo | undefined>;
  /** Aviso fisico de que quedo leido: el guardia no mira la pantalla. */
  readonly confirmar: () => void;
  readonly firmar: (input: {
    uid: string; method: 'qr'; scannedAt: string;
    latitude?: number; longitude?: number; accuracyM?: number;
  }) => Promise<{
    clientScanId: string; deviceId: string; signature: string;
  }>;
  readonly ahora?: () => Date;
}

export interface LectorQr {
  readonly escanear: (timeoutMs: number, titulo?: string) => Promise<ResultadoEscaneoQrPayload>;
  readonly cancelar: () => void;
}

const CANCELADO = () => new ErrorEscaneo('cancelado', 'Escaneo cancelado.', false);

export function crearLectorQr(puerto: PuertoQr): LectorQr {
  let escaneoActivo = false;
  let cancelado = false;

  async function escanear(
    timeoutMs: number,
    titulo?: string,
  ): Promise<ResultadoEscaneoQrPayload> {
    if (escaneoActivo) {
      throw new ErrorEscaneo(
        'camara-ocupada',
        'La cámara ya está leyendo un código. Espera un momento.',
        true,
      );
    }
    escaneoActivo = true;
    cancelado = false;
    let temporizador: ReturnType<typeof setTimeout> | undefined;

    try {
      const permiso = await puerto.permisoCamara();
      if (permiso !== 'concedido') {
        // Un permiso denegado NO es una falla tecnica: es algo que la persona
        // puede resolver, y el texto tiene que decir donde. "denegado-definitivo"
        // significa que el dialogo del sistema ya no aparece y la unica salida
        // es Ajustes; repetir el pedido ahi seria un boton que no hace nada.
        throw new ErrorEscaneo(
          'permiso-denegado',
          permiso === 'denegado-definitivo'
            ? 'La cámara está bloqueada para VoxIA Control. Actívala en los ajustes del teléfono.'
            : 'Sin permiso de cámara no se puede leer el código QR del punto.',
          permiso !== 'denegado-definitivo',
        );
      }

      puerto.abrirCamara(titulo);

      const vencimiento = new Promise<never>((_, rechazar) => {
        temporizador = setTimeout(
          () => rechazar(new ErrorEscaneo(
            'timeout',
            'No se leyó ningún código. Acerca la cámara al QR del punto.',
            true,
          )),
          timeoutMs,
        );
      });

      let uid: string | undefined;
      while (uid === undefined) {
        const leido = await Promise.race([puerto.esperarCodigo(), vencimiento]);
        if (cancelado) throw CANCELADO();
        const texto = leido.trim();
        // Un codigo ajeno no interrumpe: la camara sigue mirando. Cortar aca
        // obligaria al guardia a reintentar por cada afiche del pasillo.
        if (esCodigoQrDePunto(texto)) uid = texto;
      }

      puerto.confirmar();
      const scannedAt = (puerto.ahora?.() ?? new Date()).toISOString();
      const posicion = await puerto.posicion().catch(() => undefined);
      const scan = {
        uid,
        scannedAt,
        ...(posicion ?? {}),
      };
      const firma = await puerto.firmar({ ...scan, method: 'qr' });
      return { ...scan, tech: 'qr', ...firma };
    } catch (causa) {
      if (causa instanceof ErrorEscaneo) throw causa;
      if (cancelado) throw CANCELADO();
      throw new ErrorEscaneo(
        'error-desconocido',
        'No se pudo usar la cámara para leer el código.',
        true,
      );
    } finally {
      if (temporizador) clearTimeout(temporizador);
      // Pase lo que pase, la camara se apaga. Es la diferencia entre un error y
      // un telefono que se queda mostrando la camara en medio de la ronda.
      puerto.cerrarCamara();
      escaneoActivo = false;
    }
  }

  function cancelar(): void {
    cancelado = true;
    puerto.cerrarCamara();
  }

  return { escanear, cancelar };
}
