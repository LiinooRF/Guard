import * as Location from 'expo-location';

import type { IniciarTrazaPayload, PuntoDeTrazaPayload } from '../bridge/protocol';

/**
 * El muestreador de la traza en vivo (#280) — la mitad NATIVA del emisor que
 * faltaba: todo el rastreo estaba construido (endpoint, tabla, mapa del
 * supervisor, reglas, el aviso legal que promete una posicion por minuto) y
 * nadie enviaba posiciones.
 *
 * POR TIEMPO, no por movimiento — y eso se aprendio con el telefono en la mano:
 * `watchPositionAsync` en Android empuja posiciones cuando el equipo SE MUEVE,
 * asi que un guardia detenido en un acceso (o el telefono de prueba quieto en
 * un escritorio) desaparecia del mapa. El aviso legal promete "una posicion
 * cada N segundos", que es muestreo por reloj: temporizador +
 * `getCurrentPositionAsync`, una posicion por tick, quieto o caminando.
 *
 * Reglas de la casa que este archivo respeta a proposito:
 *
 * - **Solo muestrea mientras el PORTAL lo pide** (`track.start` con la ronda en
 *   curso, `track.stop` al cerrarla). "No se rastrea fuera del turno" es un
 *   compromiso legal demostrable, y la ultima linea de defensa sigue siendo el
 *   servidor, que rechaza posiciones fuera de la ventana.
 * - **No pide permisos.** Si el permiso de ubicacion no esta concedido, no hay
 *   traza y no hay dialogo: el permiso se negocia en su momento, con su aviso
 *   (#275). Pedirlo aqui seria un dialogo del sistema sin divulgacion previa.
 * - **PRIMER PLANO.** Con la pantalla apagada el muestreo se detiene solo: el
 *   segundo plano es la causa numero 1 de rechazo en Google Play y va aparte,
 *   con su formulario, cuando se decida (v2 de #280).
 * - Ninguna posicion se guarda aqui: cada punto viaja al portal, que lo sube
 *   con SU sesion. El shell no conoce al guardia.
 */

let temporizador: ReturnType<typeof setInterval> | undefined;
let midiendo = false;

async function medir(emitir: (punto: PuntoDeTrazaPayload) => void): Promise<void> {
  // Un tick que encuentra al anterior todavia midiendo se salta: dos fixes en
  // vuelo no dan mejor traza, solo mas bateria.
  if (midiendo) return;
  midiendo = true;
  try {
    const posicion = await Location.getCurrentPositionAsync({
      // Balanced y no High: la traza es contexto ("por donde va"), no
      // evidencia. La evidencia es el escaneo, que si usa High en su instante.
      accuracy: Location.Accuracy.Balanced,
    });
    emitir({
      recordedAt: new Date(posicion.timestamp).toISOString(),
      latitude: posicion.coords.latitude,
      longitude: posicion.coords.longitude,
      ...(posicion.coords.accuracy === null || posicion.coords.accuracy === undefined
        ? {}
        : { accuracyM: posicion.coords.accuracy }),
    });
  } catch {
    // Sin fix en este tick (subterraneo, GPS frio): el hueco en la traza ES el
    // dato — track-summary lo mide — y el proximo tick lo intenta de nuevo.
  } finally {
    midiendo = false;
  }
}

export async function iniciarTraza(
  peticion: IniciarTrazaPayload,
  emitir: (punto: PuntoDeTrazaPayload) => void,
): Promise<void> {
  // Idempotente: un start nuevo pisa al anterior en vez de duplicar relojes.
  // El portal re-manda track.start en cada carga de la pantalla de ronda.
  detenerTraza();

  const permiso = await Location.getForegroundPermissionsAsync();
  if (permiso.status !== 'granted') return;

  const intervaloMs = Math.max(peticion.intervalSeconds, 15) * 1000;
  // La primera posicion sale AHORA, no en un intervalo: el supervisor que abre
  // el mapa cuando la ronda parte no debe esperar un minuto para ver algo.
  void medir(emitir);
  temporizador = setInterval(() => void medir(emitir), intervaloMs);
}

export function detenerTraza(): void {
  if (temporizador !== undefined) {
    clearInterval(temporizador);
    temporizador = undefined;
  }
}
