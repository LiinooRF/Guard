/**
 * Estados del registro de envios (#44). Espejo EXACTO del CHECK de
 * mail_deliveries: si aca entra uno nuevo, la migracion tiene que admitirlo o el
 * UPDATE revienta en produccion con el test en verde.
 *
 *   encolado  — la cola acepto el correo. Todavia no salio.
 *   enviado   — el servidor SMTP lo acepto. NO significa que llego a la bandeja.
 *   entregado — el proveedor confirmo la entrega en el buzon del destinatario.
 *   rebotado  — el servidor del destinatario lo rechazo (casilla inexistente,
 *               llena, dominio caido).
 *   reclamo   — el destinatario lo marco como spam. No es un error de envio y
 *               por eso no es 'rebotado': se atiende distinto.
 *   fallido   — se agotaron los reintentos sin poder entregarlo al servidor.
 *
 * 'enviado' y 'entregado' se confunden seguido y no son lo mismo: que el relay
 * SMTP acepte el mensaje solo dice que se hizo cargo de intentarlo. La pregunta
 * del jefe de operaciones —"¿le llego el informe al cliente?"— la responde
 * 'entregado', y ese dato solo existe cuando el proveedor lo reporta.
 */
export const ESTADOS_ENVIO = [
  'encolado',
  'enviado',
  'entregado',
  'rebotado',
  'reclamo',
  'fallido',
] as const;
export type EstadoEnvio = (typeof ESTADOS_ENVIO)[number];

/**
 * Lo que un proveedor puede reportar por webhook. Es un subconjunto de
 * EstadoEnvio a proposito: 'encolado', 'enviado' y 'fallido' los sabe el sistema
 * de primera mano y nadie de afuera puede escribirlos.
 */
export const EVENTOS_PROVEEDOR = ['entregado', 'rebotado', 'reclamo'] as const;
export type EventoProveedor = (typeof EVENTOS_PROVEEDOR)[number];

/** Estados desde los que un evento del proveedor todavia puede cambiar la fila. */
export const ESTADOS_ABIERTOS_A_PROVEEDOR: readonly EstadoEnvio[] = ['enviado', 'entregado'];

/**
 * Contexto de negocio del correo, que la cola por si sola no conoce.
 *
 * `MailJobData` transporta destinatario, plantilla renderizada y tenant, pero no
 * QUE es el correo ni de que ronda habla — y eso es justo lo que hay que
 * registrar. Todo es opcional: un correo sin contexto igual queda registrado,
 * con la plantilla deducida de la clave de idempotencia.
 */
export interface DatosRegistroEnvio {
  /** Clave de catalogo de la plantilla, en minusculas: 'informe-ronda'. */
  readonly plantilla?: string;
  /** Ronda a la que pertenece el correo, cuando la hay. */
  readonly patrolId?: string | null;
  /** Usuario del sistema detras del destinatario, cuando lo hay. */
  readonly usuarioId?: string | null;
}

/**
 * Lo minimo que el registro necesita de un job de BullMQ.
 *
 * Es un tipo estructural y no `Job<MailJobData>` para que el registro no dependa
 * de bullmq: los tests arman un objeto plano y el processor pasa el job real sin
 * conversion.
 *
 * `data` se describe suelto y no como `MailJobData` a proposito: este archivo lo
 * importa `mail-queue.types.ts` para declarar `EnqueueMailOptions.registro`, y
 * apuntar de vuelta cerraria un ciclo entre los dos.
 */
export interface JobDeCorreo {
  readonly id?: string | undefined;
  readonly data: { readonly tenantId: string | null };
  /** Intentos YA consumidos antes del actual. En el primer intento vale 0. */
  readonly attemptsMade: number;
}

/** Evento de entrega ya validado, tal como entra al registro. */
export interface EventoEntrega {
  /** Message-ID que devolvio el SMTP al enviar. */
  readonly messageId: string;
  readonly evento: EventoProveedor;
  /** Cuando ocurrio segun el proveedor. */
  readonly ocurridoEn: Date;
  /** Motivo del rebote, si el proveedor lo manda. */
  readonly motivo?: string | null;
}

/** Por que un evento del proveedor no cambio nada. `null` = si cambio la fila. */
export type MotivoIgnorado =
  | 'sin_correlacion'
  | 'sin_registro'
  | 'estado_no_aplica';

export interface ResultadoEvento {
  readonly aplicado: boolean;
  readonly ignorado: MotivoIgnorado | null;
}

/** Una fila del registro, como la ve la vista de soporte. */
export interface EnvioRegistrado {
  readonly id: string;
  readonly plantilla: string;
  readonly destinatario: string;
  readonly destinatarioUsuarioId: string | null;
  readonly patrolId: string | null;
  readonly estado: EstadoEnvio;
  readonly intentos: number;
  readonly ultimoError: string | null;
  readonly encoladoEn: Date;
  readonly enviadoEn: Date | null;
  readonly entregadoEn: Date | null;
  readonly falladoEn: Date | null;
}

/** Filtros de la vista de soporte. */
export interface FiltroRegistro {
  readonly siteId?: string | null;
  readonly estado?: EstadoEnvio | null;
  readonly plantilla?: string | null;
  /** Fecha local AAAA-MM-DD, interpretada en la zona horaria del RECINTO. */
  readonly desde?: string | null;
  /** Fecha local AAAA-MM-DD, inclusiva: el dia indicado entra completo. */
  readonly hasta?: string | null;
  readonly limite?: number | null;
}
