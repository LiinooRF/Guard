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

/**
 * Cuanto se espera un fix FRESCO antes de conformarse con el ultimo conocido.
 * `getCurrentPositionAsync` puede colgarse INDEFINIDAMENTE esperando un fix
 * que bajo techo no llega — se vio en el telefono real: proveedor fused sano,
 * ultimo fix valido, y el await que nunca volvia (con `midiendo` atascada,
 * cada tick posterior se saltaba y la traza quedaba en cero para siempre).
 */
const MS_ESPERA_FIX = 12_000;

/**
 * Un fix viejo deja de ser verdad: mas alla de esto, mejor un hueco honesto.
 *
 * Eran 10 minutos y era demasiado: caminando, en diez minutos un guardia cruza
 * medio recinto, asi que ese punto viejo dibujaba en el informe un salto que
 * nunca ocurrio. Dos minutos acotan el error a la distancia que se recorre en
 * ese rato, y si no hay nada fresco el hueco se ve y se explica solo.
 */
const MS_MAX_FIX_CONOCIDO = 2 * 60_000;

async function medir(emitir: (punto: PuntoDeTrazaPayload) => void): Promise<void> {
  // Un tick que encuentra al anterior todavia midiendo se salta: dos fixes en
  // vuelo no dan mejor traza, solo mas bateria.
  if (midiendo) return;
  midiendo = true;
  try {
    // Carrera contra el reloj: el fix fresco es lo ideal, pero un await que no
    // vuelve no es un fix, es un cerrojo. Si pierde, vale el ultimo conocido
    // (con su hora REAL, que es la honestidad del punto), y sin ninguno, el
    // hueco: track-summary lo mide y el proximo tick reintenta.
    const fresco = await Promise.race([
      Location.getCurrentPositionAsync({
        /*
         * High y no Balanced.
         *
         * El razonamiento anterior era que la traza es contexto y la evidencia
         * es el escaneo. Se sostiene en abstracto, pero choca con lo que pasa
         * despues: ese trazo termina impreso en el informe que recibe el
         * cliente, y ahi deja de ser contexto.
         *
         * Medido sobre un recorrido real en Janssen con Balanced: precision
         * mediana de 66 m, picos de 215, y saltos de hasta 131 m entre puntos
         * consecutivos. Balanced resuelve por antenas y wifi, asi que el
         * guardia camina derecho y el informe dibuja un zigzag.
         *
         * High enciende el GPS. Con un fix por minuto el costo en bateria es
         * moderado —se prende un instante y se apaga— y a cambio el recorrido
         * pasa de decenas de metros de error a unos pocos.
         */
        accuracy: Location.Accuracy.High,
      }),
      new Promise<null>((resolver) => {
        setTimeout(() => resolver(null), MS_ESPERA_FIX);
      }),
    ]);
    const posicion =
      fresco ?? (await Location.getLastKnownPositionAsync({ maxAge: MS_MAX_FIX_CONOCIDO }));
    if (!posicion) return;
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
