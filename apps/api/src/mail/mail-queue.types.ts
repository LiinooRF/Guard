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
