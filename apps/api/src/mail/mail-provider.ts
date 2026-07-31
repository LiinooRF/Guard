export const MAIL_PROVIDER = Symbol('MAIL_PROVIDER');

export type MailTemplateVariables = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

/**
 * Contenido independiente del transporte. El catalogo de plantillas y la
 * personalizacion por tenant pertenecen a #42; este contrato solo transporta
 * contenido ya definido sin acoplar el negocio a SMTP o Mailpit.
 */
export interface MailTemplate {
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface MailDelivery {
  readonly messageId: string;
  readonly accepted: readonly string[];
  readonly rejected: readonly string[];
}

export interface MailProvider {
  send(
    to: string,
    template: MailTemplate,
    vars: MailTemplateVariables,
    tenantId: string,
  ): Promise<MailDelivery>;
}
