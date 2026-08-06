import type { MailAttachment, MailTemplate, MailTemplateVariables } from './mail-provider';

export interface MailJobData {
  readonly to: string;
  readonly template: MailTemplate;
  readonly variables: MailTemplateVariables;
  readonly tenantId: string | null;
  /** Adjuntos chicos (informe PDF de #17). El job viaja por Redis: nada de megas. */
  readonly attachments?: readonly MailAttachment[];
}

export interface EnqueueMailOptions {
  /**
   * Identifica el hecho de negocio, no el intento de entrega. BullMQ evita
   * crear un segundo job mientras conserve el primero, incluso si ya termino.
   */
  readonly idempotencyKey: string;
}

/**
 * Por que un correo no se encolo (#86).
 *
 *   dominio_bloqueado — el dominio del destinatario cae bajo la lista de
 *                       dominios no despachables. Es el caso normal: las
 *                       cuentas demo `@demo-andina.test`. No hay nada que
 *                       arreglar, el sistema esta haciendo su trabajo.
 *   sin_dominio       — la direccion no tiene dominio del que hablar. Eso NO es
 *                       una cuenta de prueba: es un dato malo en la base o en
 *                       la configuracion, y se arregla en otro lado.
 *
 * Son dos motivos y no un booleano porque son dos problemas distintos con dos
 * arreglos distintos, y quien lee el log tiene que poder separarlos.
 */
export type MotivoNoDespachado = 'dominio_bloqueado' | 'sin_dominio';

/**
 * Lo que devuelve `MailQueueService.enqueue`.
 *
 * ES UNA UNION DISCRIMINADA A PROPOSITO, Y LA RAMA SUPRIMIDA NO TIENE `jobId`.
 *
 * Antes `enqueue` devolvia `{ jobId }` siempre. Con la supresion metida en la
 * cola, ese contrato se vuelve una mentira: quien anota el envio en su propia
 * bitacora —`report_deliveries` del informe, `event_notifications` del
 * escalamiento, `mail_deliveries` del registro de envios (#44)— habria
 * registrado como enviado un correo que nunca salio, y el dia que soporte
 * pregunte "¿le llego el informe?" la respuesta guardada seria falsa.
 *
 * Al no existir `jobId` en la rama suprimida, TypeScript obliga a mirar
 * `estado` antes de usarlo. Eso convierte el problema en un error de
 * compilacion en vez de una fila incorrecta en produccion, que es exactamente
 * lo que se busca: el compilador es el unico revisor que no se distrae.
 */
export type ResultadoEncolado =
  | { readonly estado: 'encolado'; readonly jobId: string }
  | { readonly estado: 'suprimido'; readonly motivo: MotivoNoDespachado };
