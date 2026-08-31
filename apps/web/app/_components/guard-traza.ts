import type { PuntoDeTrazaPayload } from '../_lib/bridge/protocol';

/**
 * La cola de la traza en vivo (#280), separada del hook para probarse sin DOM.
 *
 * El shell entrega una posicion por intervalo y este modulo decide que viaja al
 * servidor y que se guarda para despues. Las rondas ocurren en subterraneos y
 * perimetros sin señal (regla 4 de CLAUDE.md): perder puntos por un POST caido
 * seria perder justo los tramos que mas explican un recorrido.
 */

/**
 * Mismo tope que `MAX_PUNTOS_POR_LOTE` del servidor (2.000): al intervalo por
 * defecto de 15 s son 8 horas sin señal, o sea un turno completo. Sobre el tope
 * se descarta EL MAS VIEJO: si la ronda estuvo horas sin señal, el final del
 * recorrido explica mas que el principio.
 *
 * El tope NO se sube solo: es el mismo numero que el DTO del servidor acepta
 * por lote, y subirlo aca sin subirlo alla convierte la cola larga en un 400
 * justo cuando por fin hay señal para vaciarla.
 */
export const MAX_PUNTOS_EN_COLA = 2_000;

export interface ColaDeTraza {
  readonly pendientes: readonly PuntoDeTrazaPayload[];
}

export function colaVacia(): ColaDeTraza {
  return { pendientes: [] };
}

/** Suma un punto respetando el tope. Pura: devuelve la cola nueva. */
export function acumular(cola: ColaDeTraza, punto: PuntoDeTrazaPayload): ColaDeTraza {
  const pendientes = [...cola.pendientes, punto];
  return {
    pendientes: pendientes.length > MAX_PUNTOS_EN_COLA
      ? pendientes.slice(pendientes.length - MAX_PUNTOS_EN_COLA)
      : pendientes,
  };
}

/**
 * Que mandar ahora. Todo lo pendiente viaja en UN lote: el DTO del servidor
 * acepta hasta el mismo tope, y mandar de a uno tras recuperar señal seria
 * un request por minuto de desconexion.
 */
export function loteParaEnviar(cola: ColaDeTraza): readonly PuntoDeTrazaPayload[] {
  return cola.pendientes;
}

/**
 * El resultado del POST decide la cola siguiente:
 * - enviado: la cola queda vacia.
 * - fallo de red (o 5xx): se conserva TODO y se reintenta con el proximo punto.
 * - rechazo del servidor (4xx): se descarta el lote. Un 403 aqui es el gate de
 *   consentimiento o el fin del turno hablando — insistir seria pelear contra
 *   la politica, y el "no se rastrea fuera del turno" manda.
 */
export function trasEnviar(
  cola: ColaDeTraza,
  enviados: number,
  resultado: 'enviado' | 'fallo-red' | 'rechazado',
): ColaDeTraza {
  if (resultado === 'fallo-red') return cola;
  const restantes = cola.pendientes.slice(enviados);
  return { pendientes: restantes };
}
