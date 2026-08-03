import nodemailer from 'nodemailer';

import { NodemailerMailProvider, type MailTransport } from './nodemailer-mail-provider';

export interface MailpitProviderOptions {
  readonly from: string;
  readonly host: string;
  readonly port: number;
  readonly transport?: MailTransport;
}

/**
 * Adaptador de desarrollo: Mailpit captura el mensaje por SMTP local y nunca
 * entrega correo a Internet.
 */
export class MailpitProvider extends NodemailerMailProvider {
  constructor(options: MailpitProviderOptions) {
    const transport =
      options.transport ??
      nodemailer.createTransport({
        host: options.host,
        port: options.port,
        secure: false,
      });

    super(transport, options.from, 'mailpit');
  }
}
