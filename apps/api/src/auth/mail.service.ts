import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { MailQueueService } from '../mail/mail-queue.service';
import type { ResultadoEncolado } from '../mail/mail-queue.types';

@Injectable()
export class MailService {
  constructor(
    private readonly config: ConfigService,
    private readonly queue: MailQueueService,
  ) {}

  /**
   * El retorno es `ResultadoEncolado` y ya no `unknown` (#86).
   *
   * La invitacion es el correo que se manda al crear un tenant, y los tenants
   * demo usan `@demo-andina.test`, que la cola SUPRIME. Con `unknown` el
   * llamador no tenia forma de saberlo: el alta terminaba "bien" y la
   * invitacion no existia. Devolver el resultado no obliga a nadie a mirarlo,
   * pero permite hacerlo — hoy `admin.service.ts`, `provisioning.service.ts` y
   * `auth.service.ts` lo descartan a proposito.
   */
  invitation(
    recipient: string,
    token: string,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<ResultadoEncolado> {
    const link = `${this.publicWebUrl()}/#invite=${encodeURIComponent(token)}`;
    return this.queue.enqueue(
      {
        to: recipient,
        tenantId,
        template: {
          subject: 'Activa tu acceso a SentryCore',
          text:
            `Tu organización te invitó a SentryCore.\n\n` +
            `Define tu contraseña desde este enlace, válido por 24 horas:\n${link}\n\n` +
            `Si no esperabas esta invitación, ignora el mensaje.`,
        },
        variables: {},
      },
      { idempotencyKey },
    );
  }

  /**
   * La recuperacion de contrasena responde igual exista o no la cuenta, a
   * proposito: es lo que evita enumerar usuarios. Una supresion por dominio se
   * ve igual desde fuera, asi que este retorno es para el log y las metricas
   * del servidor, nunca para la respuesta HTTP.
   */
  passwordReset(
    recipient: string,
    token: string,
    tenantId: string | null,
    idempotencyKey: string,
  ): Promise<ResultadoEncolado> {
    const link = `${this.publicWebUrl()}/#reset=${encodeURIComponent(token)}`;
    return this.queue.enqueue(
      {
        to: recipient,
        tenantId,
        template: {
          subject: 'Recupera tu acceso a SentryCore',
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
