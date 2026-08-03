import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import nodemailer, { type Transporter } from 'nodemailer';

@Injectable()
export class MailService {
  private readonly transporter: Transporter;

  constructor(private readonly config: ConfigService) {
    const mailpit = this.config.get<string>('MAIL_DRIVER', 'mailpit') === 'mailpit';
    this.transporter = nodemailer.createTransport({
      host: mailpit ? 'localhost' : this.config.getOrThrow<string>('SMTP_HOST'),
      port: mailpit ? 1025 : this.config.get<number>('SMTP_PORT', 587),
      secure: mailpit ? false : this.config.get<boolean>('SMTP_SECURE', false),
      auth: mailpit || !this.config.get<string>('SMTP_USER')
        ? undefined
        : {
            user: this.config.get<string>('SMTP_USER'),
            pass: this.config.get<string>('SMTP_PASSWORD'),
          },
    });
  }

  invitation(recipient: string, token: string): Promise<unknown> {
    const link = `${this.publicWebUrl()}/#invite=${encodeURIComponent(token)}`;
    return this.transporter.sendMail({
      from: this.config.get<string>('MAIL_FROM', 'VoxIA Control <no-reply@localhost>'),
      to: recipient,
      subject: 'Activa tu acceso a VoxIA Control',
      text:
        `Tu organización te invitó a VoxIA Control.\n\n` +
        `Define tu contraseña desde este enlace, válido por 24 horas:\n${link}\n\n` +
        `Si no esperabas esta invitación, ignora el mensaje.`,
    });
  }

  passwordReset(recipient: string, token: string): Promise<unknown> {
    const link = `${this.publicWebUrl()}/#reset=${encodeURIComponent(token)}`;
    return this.transporter.sendMail({
      from: this.config.get<string>('MAIL_FROM', 'VoxIA Control <no-reply@localhost>'),
      to: recipient,
      subject: 'Recupera tu acceso a VoxIA Control',
      text:
        `Recibimos una solicitud para cambiar tu contraseña.\n\n` +
        `Define una nueva desde este enlace, válido por 30 minutos:\n${link}\n\n` +
        `Si no fuiste tú, ignora el mensaje.`,
    });
  }

  private publicWebUrl(): string {
    return this.config.get<string>('WEB_PUBLIC_URL', 'http://localhost:3000').replace(/\/$/, '');
  }
}
