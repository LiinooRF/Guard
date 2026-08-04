import type { MarcaCorreo } from './plantillas-marca';
import { direccionDeRemitente } from './plantillas-marca';

/**
 * El sobre del correo: `From` y `Reply-To` por tenant (#42).
 *
 * LA REGLA, EN UNA LINEA: el NOMBRE del From es del tenant siempre; la
 * DIRECCION del From es de la plataforma hasta que la plataforma acredite el
 * dominio del tenant.
 *
 * Por que el nombre si y la direccion no. SPF y DKIM autorizan un DOMINIO a
 * mandar correo. El relay del SaaS firma con el dominio de la plataforma; si
 * ademas el From dijera `algo@dominio-del-cliente.cl`, DMARC ve un mensaje
 * firmado por un dominio y presentado como otro, y lo manda a spam o lo
 * rechaza. El nombre visible, en cambio, no interviene en ninguna de las tres
 * validaciones: se puede cambiar libremente y es lo que el cliente lee primero
 * en la bandeja.
 *
 * El Reply-To es el que cierra el circulo del white-label: el cliente aprieta
 * "responder" y le contesta a SU proveedor, no a la plataforma. Reply-To no lo
 * valida SPF ni DKIM, asi que se puede apuntar a donde quiera el tenant.
 *
 * Resultado que ve el cliente:
 *     De:        Seguridad Andes <avisos@voxiacontrol.cl>
 *     Responder: contacto@seguridadandes.cl
 * y no una sola linea con la marca del revendedor, que es lo que salia antes.
 */

export interface SobreCorreo {
  /** Cabecera From ya armada y segura para pasarle a nodemailer. */
  readonly from: string;
  readonly replyTo?: string;
}

/** Tope conservador para no partir la cabecera en dos lineas. */
const MAX_NOMBRE = 78;

/** Forma minima de una direccion utilizable en una cabecera. */
const DIRECCION = /^[^@\s]+@[^@\s]+\.[A-Za-z]{2,24}$/;

/**
 * Caracteres de control (CR, LF y compañia) y de formato invisible.
 *
 * Se escriben como categorias Unicode y no como un rango con barras: un byte
 * de control literal dentro del archivo fuente es justo lo que nadie alcanza a
 * ver en una revision de codigo.
 */
const CONTROLES = /[\p{Cc}\p{Cf}]+/gu;

export function construirSobre(marca: MarcaCorreo, remitentePlataforma: string): SobreCorreo {
  const direccionPlataforma = direccionDeRemitente(remitentePlataforma);
  const direccion =
    marca.fromAddressVerificada !== null && DIRECCION.test(marca.fromAddressVerificada)
      ? marca.fromAddressVerificada
      : direccionPlataforma;

  const nombre = nombreParaCabecera(marca.nombreRemitente);
  const from = nombre.length > 0 ? `${nombre} <${direccion}>` : direccion;

  const replyTo = (marca.replyTo ?? '').trim();
  // El Reply-To se revalida aunque la base ya tenga su CHECK: por este mismo
  // camino pasa la marca de la plataforma, que no viene de ninguna tabla.
  if (replyTo.length === 0 || !DIRECCION.test(replyTo)) return { from };
  return { from, replyTo };
}

/**
 * El nombre visible, entrecomillado como quoted-string de RFC 5322.
 *
 * Tres cosas que se limpian y ninguna es paranoia de manual:
 *  - CR y LF: un nombre con salto de linea inyecta cabeceras (un Bcc, por
 *    ejemplo). Es la version de este campo del clasico header injection.
 *  - `<` y `>`: un nombre como `soporte@banco.cl <x>` deja al cliente de correo
 *    mostrando algo que parece una direccion distinta de la real.
 *  - `"` y `\`: rompen el propio entrecomillado si no se escapan.
 *
 * No se codifica a RFC 2047 aca: nodemailer parsea la cabecera y codifica solo
 * lo que haga falta. Codificarlo dos veces dejaria el nombre ilegible.
 */
export function nombreParaCabecera(nombre: string): string {
  const limpio = nombre
    .replace(CONTROLES, ' ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NOMBRE)
    .trim();

  if (limpio.length === 0) return '';
  const escapado = limpio.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return `"${escapado}"`;
}
