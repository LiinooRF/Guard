import { verificarFirma } from './registro-envios.firma';
import type {
  MotivoRechazo,
  PeticionWebhook,
  Traduccion,
  TraductorWebhookCorreo,
} from './registro-envios.traductor';
import { EVENTOS_PROVEEDOR, type EventoEntrega, type EventoProveedor } from './registro-envios.types';

/**
 * Traductor del contrato INTERNO de ingesta (#220).
 *
 * QUE ES
 * El unico traductor que se puede escribir sin saber quien va a ser el proveedor
 * (#9): el formato lo definimos nosotros, lo firma un HMAC con secreto
 * compartido y lo alimenta un relay de una pagina que convierte el webhook del
 * proveedor que se elija. Sirve tal cual con cualquier servidor SMTP
 * self-hosted, que es lo que MAIL_DRIVER=smtp ya cubre.
 *
 * EL CUERPO ES UN EVENTO O UN LOTE DE EVENTOS, y cada uno trae SU PROPIA FIRMA.
 * Los proveedores agrupan: un POST de SES o SendGrid trae los eventos de varios
 * mensajes. Firmar el lote entero obligaria al relay a canonicalizar un arreglo
 * —el problema que la cadena canonica de tres campos evita— y ademas dejaria que
 * un evento colado dentro del lote viajara amparado por la firma de los otros.
 *
 * UN SOLO ELEMENTO MAL FIRMADO TUMBA EL LOTE COMPLETO. Aplicar los buenos y
 * callar el malo le devolveria 202 a quien inyecto el evento falso, y el rechazo
 * no quedaria en ninguna parte. Como el relay es nuestro y comparte el secreto,
 * un elemento que no verifica es un incidente, no un caso normal.
 *
 * POR QUE VALIDA A MANO Y NO CON UN DTO DE class-validator
 * Porque el cuerpo lo manda un tercero y el ValidationPipe global corre con
 * `forbidNonWhitelisted: true`: un campo de mas —y los proveedores siempre
 * mandan campos de mas— responderia 400 antes de que nadie mire la firma. Un
 * endpoint publico tiene que poder ignorar lo que no entiende. Ademas, con el
 * cuerpo tipado como `unknown` el ValidationPipe no se mete (`toValidate()`
 * saltea `Object`), que es justo lo que hace falta para que el traductor de cada
 * proveedor lea su propio formato.
 *
 * LOS TRES CAMPOS FIRMADOS SE USAN VERBATIM. No se recortan ni se pasan a
 * minusculas antes de verificar: la firma cubre los bytes que mando el relay, y
 * normalizarlos aca haria fallar peticiones legitimas por un espacio. La
 * normalizacion del Message-ID para buscar la correlacion ya existe y vive donde
 * corresponde (registro-envios.correlacion.ts).
 *
 * TODO LO QUE NO ES UNA PETICION FIRMADA Y FRESCA SE RECHAZA IGUAL, con 403 y
 * sin decir que fallo. Distinguir "el JSON esta mal" de "la firma no calza" le
 * regala a quien prueba el endpoint un mapa de nuestro formato; el motivo queda
 * en el log del servidor, que es donde soporte lo necesita.
 */
export class TraductorContratoInterno implements TraductorWebhookCorreo {
  readonly nombre = 'interno';

  /**
   * El secreto se recibe al construir y no se lee por peticion: si falta, el
   * canal esta apagado y todas las peticiones fallan CERRADAS con 'sin_secreto'.
   * Un webhook que acepta cualquier cuerpo porque a nadie se le ocurrio poner la
   * variable de entorno deja que cualquiera escriba el estado de entrega de una
   * empresa que no es suya.
   */
  constructor(private readonly secreto: string | undefined) {}

  async traducir(peticion: PeticionWebhook): Promise<Traduccion> {
    const crudos = elementosDelCuerpo(peticion.cuerpo);
    if (crudos === null) return rechazo('cuerpo_invalido');

    const eventos: EventoEntrega[] = [];
    for (const crudo of crudos) {
      const traducido = this.traducirUno(crudo, peticion.recibidoEnMs);
      if (!traducido.ok) return traducido;
      // `null` es un evento que el registro no modela (apertura, clic): no es un
      // rechazo, simplemente no entra a la lista.
      if (traducido.evento !== null) eventos.push(traducido.evento);
    }

    return { ok: true, eventos };
  }

  /** Un elemento del cuerpo: o un evento, o nada que registrar, o el rechazo. */
  private traducirUno(
    crudo: unknown,
    recibidoEnMs: number,
  ): { ok: true; evento: EventoEntrega | null } | { ok: false; motivo: MotivoRechazo } {
    const campos = objetoPlano(crudo);
    if (campos === null) return { ok: false, motivo: 'cuerpo_invalido' };

    const messageId = cadena(campos.messageId, MESSAGE_ID_MAX);
    const evento = cadena(campos.evento, EVENTO_MAX);
    const timestamp = enteroDeSegundos(campos.timestamp);
    if (messageId === null || evento === null || timestamp === null) {
      return { ok: false, motivo: 'cuerpo_invalido' };
    }

    const firma = cadena(campos.firma, FIRMA_MAX);
    if (firma === null) return { ok: false, motivo: 'firma_ausente' };

    // LA FIRMA SE VERIFICA ANTES DE DECIDIR SI EL EVENTO NOS INTERESA. Al reves,
    // un cuerpo sin firmar con `evento: "open"` se llevaria un 202 y el endpoint
    // contestaria distinto segun lo que le manden sin haber autenticado nada.
    const veredicto = verificarFirma(this.secreto, { messageId, evento, timestamp, firma }, recibidoEnMs);
    if (!veredicto.valido) {
      return {
        ok: false,
        motivo: veredicto.motivo === 'invalida' ? 'firma_invalida' : veredicto.motivo,
      };
    }

    const conocido = eventoConocido(evento);
    if (conocido === null) return { ok: true, evento: null };

    return {
      ok: true,
      evento: {
        messageId,
        evento: conocido,
        // El instante lo firma el relay y ya paso la ventana de frescura.
        ocurridoEn: new Date(timestamp * 1000),
        motivo: motivoDeRebote(campos.motivo),
      },
    };
  }
}

/**
 * Largo maximo del Message-ID, espejo del CHECK de
 * mail_deliveries.provider_message_id (BETWEEN 1 AND 400): uno mas largo no va a
 * correlacionar con ninguna fila.
 */
const MESSAGE_ID_MAX = 400;
/** Los eventos del contrato miden ocho letras; el tope solo acota lo que se firma. */
const EVENTO_MAX = 40;
const FIRMA_MAX = 128;

/**
 * Cuantos eventos admite un POST. No es una regla de negocio —no cambia lo que
 * el producto hace— sino el tope de trabajo que un desconocido puede pedirle al
 * endpoint publico con una sola peticion: cada elemento cuesta una consulta a
 * Redis y hasta dos a Postgres. Los proveedores agrupan de a decenas.
 */
const LOTE_MAX = 100;

/**
 * Tope de entrada del diagnostico del rebote. El servicio lo recorta despues a
 * lo que admite la columna (300); esto solo acota lo que se copia de un cuerpo
 * que escribio un tercero.
 */
const MOTIVO_ENTRADA_MAX = 1000;

function rechazo(motivo: MotivoRechazo): Traduccion {
  return { ok: false, motivo };
}

/**
 * Los elementos a traducir: el cuerpo entero si es un objeto, sus elementos si
 * es un arreglo.
 *
 * UN ARREGLO VACIO NO ES UN RECHAZO. Es un lote sin nada que aplicar y responde
 * 202: contestarle 403 haria que el relay reintentara para siempre una peticion
 * que no tiene nada malo.
 */
function elementosDelCuerpo(cuerpo: unknown): readonly unknown[] | null {
  if (Array.isArray(cuerpo)) return cuerpo.length > LOTE_MAX ? null : cuerpo;
  return objetoPlano(cuerpo) === null ? null : [cuerpo];
}

/** El elemento tiene que ser un objeto JSON: ni arreglo, ni null, ni escalar. */
function objetoPlano(valor: unknown): Record<string, unknown> | null {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor)) return null;
  return valor as Record<string, unknown>;
}

/** Cadena no vacia y acotada, TAL CUAL vino: lo que se firmo es esto. */
function cadena(valor: unknown, largoMaximo: number): string | null {
  if (typeof valor !== 'string') return null;
  if (valor.length === 0 || valor.length > largoMaximo) return null;
  return valor;
}

function eventoConocido(valor: string): EventoProveedor | null {
  return EVENTOS_PROVEEDOR.find((conocido) => conocido === valor) ?? null;
}

/**
 * Segundos desde epoch. Se acepta el numero y tambien la cadena que lo
 * representa: el relay serializa a JSON y no todos los lenguajes distinguen. La
 * cadena canonica se arma con el numero ya convertido, asi que las dos formas
 * producen la misma firma.
 */
function enteroDeSegundos(valor: unknown): number | null {
  const numero = typeof valor === 'string' && valor.trim().length > 0 ? Number(valor) : valor;
  if (typeof numero !== 'number' || !Number.isSafeInteger(numero) || numero <= 0) return null;
  return numero;
}

/** Texto del servidor del destinatario: se acota, no se interpreta y no se loguea. */
function motivoDeRebote(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const limpio = valor.trim();
  return limpio.length === 0 ? null : limpio.slice(0, MOTIVO_ENTRADA_MAX);
}
