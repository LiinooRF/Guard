import { createHmac, timingSafeEqual } from 'node:crypto';

import { WEBHOOK_VENTANA_SEGUNDOS } from './registro-envios.constants';

/**
 * Autenticacion del webhook de estado de entrega (#44).
 *
 * QUE ES ESTE ENDPOINT Y QUE NO ES
 * NO es "el webhook de Postal", ni de SES, ni de Mailgun: el proveedor de correo
 * es la decision abierta #9 y este issue no la cierra. Cada proveedor firma con
 * su propio formato (cabecera distinta, cuerpo crudo distinto, campos
 * distintos), asi que lo que se define aca es el CONTRATO INTERNO de ingesta:
 * un traductor de una pagina —que se escribe cuando #9 se cierre— convierte el
 * webhook del proveedor elegido en esta llamada firmada.
 *
 * POR QUE SE FIRMA UNA CADENA CANONICA Y NO EL CUERPO CRUDO
 * Firmar el cuerpo tal cual llego obliga a conservar el buffer sin parsear
 * (`rawBody: true` en main.ts) y a que las dos puntas serialicen el JSON igual,
 * campo por campo y espacio por espacio. Firmar `messageId.evento.timestamp`
 * cubre exactamente los tres datos que deciden la escritura y no depende de como
 * se serializo nada.
 *
 * LA VENTANA DE FRESCURA NO ES DECORACION. Sin ella, una peticion valida
 * capturada sirve para siempre. Con ella, sirve cinco minutos. El reenvio dentro
 * de la ventana es inofensivo porque el UPDATE es idempotente: aplicar dos veces
 * "entregado" deja la fila igual.
 */

export interface PeticionFirmada {
  readonly messageId: string;
  readonly evento: string;
  /** Segundos desde epoch, tal como los firmo el traductor. */
  readonly timestamp: number;
  readonly firma: string;
}

export type MotivoFirmaInvalida = 'sin_secreto' | 'vencida' | 'invalida';

export type VeredictoFirma =
  | { readonly valido: true }
  | { readonly valido: false; readonly motivo: MotivoFirmaInvalida };

/** La cadena que se firma. Publica porque el traductor tiene que armar la misma. */
export function cadenaCanonica(messageId: string, evento: string, timestamp: number): string {
  return `${messageId}.${evento}.${timestamp}`;
}

export function firmar(
  secreto: string,
  messageId: string,
  evento: string,
  timestamp: number,
): string {
  return createHmac('sha256', secreto)
    .update(cadenaCanonica(messageId, evento, timestamp))
    .digest('hex');
}

/**
 * Verifica la firma y la frescura.
 *
 * Sin secreto configurado devuelve 'sin_secreto' y el endpoint responde que el
 * canal no esta habilitado: falla CERRADA. Un webhook que acepta cualquier
 * cuerpo porque a nadie se le ocurrio poner la variable de entorno es peor que
 * no tener webhook — deja que cualquiera escriba el estado de entrega de una
 * empresa que no es suya.
 */
export function verificarFirma(
  secreto: string | undefined,
  peticion: PeticionFirmada,
  ahoraMs: number,
  ventanaSegundos: number = WEBHOOK_VENTANA_SEGUNDOS,
): VeredictoFirma {
  if (!secreto || secreto.trim().length === 0) {
    return { valido: false, motivo: 'sin_secreto' };
  }

  if (!Number.isFinite(peticion.timestamp)) {
    return { valido: false, motivo: 'vencida' };
  }
  const desfase = Math.abs(Math.floor(ahoraMs / 1000) - peticion.timestamp);
  // En valor absoluto: un timestamp del futuro es tan sospechoso como uno viejo.
  if (desfase > ventanaSegundos) {
    return { valido: false, motivo: 'vencida' };
  }

  const esperada = firmar(secreto, peticion.messageId, peticion.evento, peticion.timestamp);
  return comparacionConstante(esperada, peticion.firma)
    ? { valido: true }
    : { valido: false, motivo: 'invalida' };
}

/**
 * timingSafeEqual lanza si los buffers no miden lo mismo, y el largo de una
 * firma hex no es secreto: se compara primero y despues en tiempo constante.
 */
function comparacionConstante(esperada: string, recibida: string): boolean {
  if (typeof recibida !== 'string' || recibida.length !== esperada.length) return false;
  return timingSafeEqual(Buffer.from(esperada, 'utf8'), Buffer.from(recibida, 'utf8'));
}
