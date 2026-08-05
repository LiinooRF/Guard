import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';

import { filasAfectadas } from '../consent/sql-result';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import {
  PUSH_JOB_ATTEMPTS,
  PUSH_JOB_BACKOFF_MS,
  PUSH_JOB_NAME,
  PUSH_QUEUE_NAME,
} from './push-queue.constants';
import type { EnqueuePushOptions, PushJobData } from './push-queue.types';
import type { PushNotification } from './push-provider';

export type DevicePlatform = 'android';

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    @InjectQueue(PUSH_QUEUE_NAME)
    private readonly queue: Queue<PushJobData>,
  ) {}

  // --------------------------------------------------------------- registro

  /**
   * Alta o refresco del dispositivo. Es idempotente a proposito: el shell
   * reregistra cada vez que abre, porque el sistema rota los tokens sin avisar
   * y un registro "una sola vez" termina en un supervisor que dejo de recibir
   * alertas sin que nadie se entere.
   *
   * EL CONFLICTO REASIGNA EL USUARIO, no lo ignora. En este rubro el telefono
   * de la empresa pasa de un turno al siguiente: si el token quedara pegado al
   * guardia anterior, sus alertas seguirian sonando en un equipo que ahora usa
   * otra persona.
   */
  async register(
    userId: string,
    token: string,
    platform: DevicePlatform,
    appVersion?: string,
  ): Promise<{ registered: true }> {
    await this.tenantContext.manager.query(
      `INSERT INTO device_tokens (tenant_id, user_id, token, platform, app_version)
       VALUES (app_tenant_id(), $1, $2, $3, $4)
       ON CONFLICT (tenant_id, token) DO UPDATE SET
         user_id = EXCLUDED.user_id,
         platform = EXCLUDED.platform,
         app_version = EXCLUDED.app_version,
         last_seen_at = now()`,
      [userId, token, platform, appVersion ?? null],
    );

    // Sin eco del token: la respuesta la puede leer un proxy y no aporta nada
    // que el cliente no tenga ya.
    return { registered: true };
  }

  /**
   * Baja del dispositivo (cierre de sesion, o el usuario apaga las alertas).
   *
   * EL FILTRO POR user_id NO ES DECORATIVO. Sin el, cualquier usuario del tenant
   * que conozca un token —o que pruebe— podria dar de baja el dispositivo de su
   * supervisor y dejarlo sin alertas de panico. Es la version silenciosa de
   * cortar la radio.
   *
   * No lanza 404 si no habia nada que borrar: el cierre de sesion se reintenta
   * al recuperar señal y tiene que poder repetirse sin ruido.
   */
  async unregister(token: string, userId: string): Promise<{ removed: boolean }> {
    // `filasAfectadas` porque un DELETE devuelve [filas, rowCount]: leido como
    // arreglo media 2 siempre y `removed` salia true aunque no se borrara nada
    // — la app daba por dado de baja un token que seguia recibiendo avisos.
    const borradas = filasAfectadas(
      await this.tenantContext.manager.query(
        `DELETE FROM device_tokens
         WHERE tenant_id = app_tenant_id() AND token = $1 AND user_id = $2
         RETURNING id`,
        [token, userId],
      ),
    );
    return { removed: borradas > 0 };
  }

  // ------------------------------------------------------------------ envio

  /**
   * Encola un aviso por destinatario. Devuelve cuantos jobs quedaron encolados.
   *
   * UN JOB POR USUARIO, no uno por lote ni uno por token:
   *
   * - Por usuario, porque la idempotencia es "a esta persona ya le avise de
   *   este hecho". Un lote compartido volveria a notificar a todos cuando falla
   *   uno solo.
   * - No por token, porque el token se resuelve al enviar (ver
   *   push-queue.types.ts) y porque un usuario con dos telefonos recibio el
   *   aviso si suena UNO.
   *
   * Se saltan los usuarios sin ningun dispositivo: la mayoria de los ADMIN
   * trabajan en el escritorio y solo tienen correo. Encolarles un job seria
   * dejar basura retenida en Redis para siempre.
   *
   * NO PROPAGA ERRORES. Este metodo lo llama el camino que registra un panico;
   * si Redis esta caido, el evento debe quedar guardado igual y el correo debe
   * salir igual. Perder el push es degradar el aviso; perder el evento es
   * perder el hecho.
   */
  async send(
    userIds: readonly string[],
    notification: PushNotification,
    options: EnqueuePushOptions,
  ): Promise<{ enqueued: number }> {
    if (options.idempotencyKey.trim().length === 0) {
      throw new Error('La clave de idempotencia del push es obligatoria');
    }

    const destinatarios = [...new Set(userIds.filter((id) => id.trim().length > 0))];
    if (destinatarios.length === 0) return { enqueued: 0 };

    try {
      const filas = await this.tenantContext.manager.query<
        Array<{ tenant_id: string; user_id: string }>
      >(
        `SELECT DISTINCT app_tenant_id()::text AS tenant_id, user_id
         FROM device_tokens
         WHERE tenant_id = app_tenant_id() AND user_id = ANY($1::uuid[])`,
        [destinatarios],
      );

      let encoladas = 0;
      for (const fila of filas) {
        const clave = `${options.idempotencyKey}:${fila.user_id}`;
        // Mismo criterio que el correo: la clave de negocio no se escribe en
        // Redis en claro, solo su hash.
        await this.queue.add(
          PUSH_JOB_NAME,
          { tenantId: fila.tenant_id, userId: fila.user_id, notification },
          {
            jobId: createHash('sha256').update(clave).digest('hex'),
            attempts: PUSH_JOB_ATTEMPTS,
            backoff: { type: 'exponential', delay: PUSH_JOB_BACKOFF_MS },
            // Retener completados es lo que sostiene la idempotencia; retener
            // fallidos forma la dead-letter que soporte puede inspeccionar.
            removeOnComplete: false,
            removeOnFail: false,
          },
        );
        encoladas += 1;
      }
      return { enqueued: encoladas };
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'push_encolado_fallo',
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return { enqueued: 0 };
    }
  }
}
