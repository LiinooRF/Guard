import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MailQueueService } from '../mail/mail-queue.service';

@Injectable()
export class MailService {
  constructor(
    private readonly config: ConfigService,
    private readonly queue: MailQueueService,
  ) {}

  invitation(
    recipient: string,
    token: string,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<unknown> {
    const link = `${this.publicWebUrl()}/#invite=${encodeURIComponent(token)}`;
    return this.queue.enqueue(
      {
        to: recipient,
        tenantId,
        template: {
          subject: 'Activa tu acceso a VoxIA Control',
          text:
            `Tu organización te invitó a VoxIA Control.\n\n` +
            `Define tu contraseña desde este enlace, válido por 24 horas:\n${link}\n\n` +
            `Si no esperabas esta invitación, ignora el mensaje.`,
        },
        variables: {},
      },
      { idempotencyKey },
    );
  }

  passwordReset(
    recipient: string,
    token: string,
    tenantId: string | null,
    idempotencyKey: string,
  ): Promise<unknown> {
    const link = `${this.publicWebUrl()}/#reset=${encodeURIComponent(token)}`;
    return this.queue.enqueue(
      {
        to: recipient,
        tenantId,
        template: {
          subject: 'Recupera tu acceso a VoxIA Control',
          text:
            `Recibimos una solicitud para cambiar tu contraseña.\n\n` +
            `Define una nueva desde este enlace, válido por 30 minutos:\n${link}\n\n` +
            `Si no fuiste tú, ignora el mensaje.`,
        },
        variables: {},
      },
      { idempotencyKey },
    );
  }

  private publicWebUrl(): string {
    return this.config.get<string>('WEB_PUBLIC_URL', 'http://localhost:3000').replace(/\/$/, '');
  }
}
