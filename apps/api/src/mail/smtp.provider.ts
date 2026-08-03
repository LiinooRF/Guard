import nodemailer from 'nodemailer';

import { NodemailerMailProvider, type MailTransport } from './nodemailer-mail-provider';

export interface SmtpProviderOptions {
  readonly from: string;
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user?: string;
  readonly password?: string;
  readonly transport?: MailTransport;
}

export class SmtpProvider extends NodemailerMailProvider {
  constructor(options: SmtpProviderOptions) {
    const transport =
      options.transport ??
      nodemailer.createTransport({
        host: options.host,
        port: options.port,
        secure: options.secure,
        ...(options.user
          ? {
              auth: {
                user: options.user,
                pass: options.password ?? '',
              },
            }
          : {}),
      });

    super(transport, options.from, 'smtp');
  }
}
