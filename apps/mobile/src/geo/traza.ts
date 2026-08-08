import * as Location from 'expo-location';

import type { IniciarTrazaPayload, PuntoDeTrazaPayload } from '../bridge/protocol';

/**
 * El muestreador de la traza en vivo (#280) — la mitad NATIVA del emisor que
 * faltaba: todo el rastreo estaba construido (endpoint, tabla, mapa del
 * supervisor, reglas, el aviso legal que promete una posicion por minuto) y
 * nadie enviaba posiciones.
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

let suscripcion: Location.LocationSubscription | undefined;

export async function iniciarTraza(
  peticion: IniciarTrazaPayload,
  emitir: (punto: PuntoDeTrazaPayload) => void,
): Promise<void> {
  // Idempotente: un start nuevo pisa al anterior en vez de duplicar watchers.
  // El portal re-manda track.start en cada carga de la pantalla de ronda.
  detenerTraza();

  const permiso = await Location.getForegroundPermissionsAsync();
  if (permiso.status !== 'granted') return;

  suscripcion = await Location.watchPositionAsync(
    {
      // Balanced y no High: la traza es contexto ("por donde va"), no
      // evidencia. La evidencia es el escaneo, que si usa High en su instante.
      accuracy: Location.Accuracy.Balanced,
      timeInterval: Math.max(peticion.intervalSeconds, 15) * 1000,
      distanceInterval: 0,
    },
    (posicion) => {
      emitir({
        recordedAt: new Date(posicion.timestamp).toISOString(),
        latitude: posicion.coords.latitude,
        longitude: posicion.coords.longitude,
        ...(posicion.coords.accuracy === null || posicion.coords.accuracy === undefined
          ? {}
          : { accuracyM: posicion.coords.accuracy }),
      });
    },
  );
}

export function detenerTraza(): void {
  suscripcion?.remove();
  suscripcion = undefined;
}
