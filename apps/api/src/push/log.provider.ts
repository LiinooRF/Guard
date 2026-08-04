import { Logger } from '@nestjs/common';

import { datosDeDeepLink } from './deep-link';
import type { PushNotification, PushProvider, PushResult } from './push-provider';

/**
 * Adaptador de desarrollo: escribe la notificacion en el log y NO manda nada.
 *
 * Es el equivalente de Mailpit para el push, y por la misma razon: en
 * desarrollo nada tiene que salir a un tercero. Ademas es el unico driver que
 * funciona sin cuenta de proveedor, asi que es el default — el resto del
 * producto se puede levantar y probar sin decidir el proveedor (#113 depende de
 * esa decision, que sigue abierta).
 *
 * Escribe titulo y cuerpo a proposito: el contrato de `PushNotification` ya
 * prohibe datos personales ahi, asi que registrarlos no filtra nada. El TOKEN
 * si es una credencial y NO se escribe nunca: solo cuantos hubo.
 */
export class LogPushProvider implements PushProvider {
  private readonly logger = new Logger('PushLogProvider');

  send(
    tokens: readonly string[],
    notification: PushNotification,
    tenantId: string,
  ): Promise<readonly PushResult[]> {
    this.logger.log(
      JSON.stringify({
        event: 'push_simulado',
        tenant_id: tenantId,
        devices: tokens.length,
        urgency: notification.urgency,
        title: notification.title,
        body: notification.body,
        data: datosDeDeepLink(notification.deepLink),
      }),
    );

    return Promise.resolve(
      tokens.map((token) => ({ token, verdict: 'entregado' as const })),
    );
  }
}
