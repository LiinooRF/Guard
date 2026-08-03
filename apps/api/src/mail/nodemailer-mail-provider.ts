import { Logger } from '@nestjs/common';
import type { SendMailOptions, SentMessageInfo, Transporter } from 'nodemailer';

import type {
  MailAttachment,
  MailDelivery,
  MailProvider,
  MailTemplate,
  MailTemplateVariables,
} from './mail-provider';
import { renderTemplate } from './template-renderer';

export type MailTransport = Pick<Transporter, 'sendMail'>;

export abstract class NodemailerMailProvider implements MailProvider {
  private readonly logger = new Logger(NodemailerMailProvider.name);

  protected constructor(
    private readonly transport: MailTransport,
    private readonly from: string,
    private readonly driver: 'mailpit' | 'smtp',
  ) {}

  async send(
    to: string,
    template: MailTemplate,
    vars: MailTemplateVariables,
    tenantId: string | null,
    attachments?: readonly MailAttachment[],
  ): Promise<MailDelivery> {
    if (to.trim().length === 0) {
      throw new Error('El destinatario de correo es obligatorio');
    }

    const rendered = renderTemplate(template, vars);
    const options: SendMailOptions = {
      from: this.from,
      to,
      subject: rendered.subject,
      text: rendered.text,
      ...(rendered.html === undefined ? {} : { html: rendered.html }),
      ...(attachments === undefined || attachments.length === 0
        ? {}
        : {
            attachments: attachments.map((attachment) => ({
              filename: attachment.filename,
              contentType: attachment.contentType,
              content: Buffer.from(attachment.contentBase64, 'base64'),
            })),
          }),
    };
    const result = (await this.transport.sendMail(options)) as SentMessageInfo;

    this.logger.log(
      JSON.stringify({
        event: 'mail_sent',
        tenant_id: tenantId,
        transport: this.driver,
        message_id: String(result.messageId ?? ''),
      }),
    );

    return {
      messageId: String(result.messageId ?? ''),
      accepted: normalizeAddresses(result.accepted),
      rejected: normalizeAddresses(result.rejected),
    };
  }
}

function normalizeAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String);
}
