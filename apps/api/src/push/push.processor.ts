import { Inject, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DataSource } from 'typeorm';

import { PUSH_PROVIDER, type PushProvider } from './push-provider';
import { PUSH_QUEUE_NAME } from './push-queue.constants';
import type { PushJobData } from './push-queue.types';

export interface PushJobResult {
  readonly delivered: number;
  readonly removed: number;
}

/**
 * Worker de entrega. Hace tres cosas y en este orden: resuelve los tokens del
 * destinatario, los manda por el puerto, y borra los que el transporte declaro
 * inexistentes.
 *
 * POR QUE ABRE SU PROPIA TRANSACCION CON CONTEXTO DE TENANT
 * `TenantContextService` vive en el AsyncLocalStorage que arma el interceptor a
 * partir del request. Aca no hay request: el job corre minutos despues, en otro
 * tick y —el dia que haya mas de una replica— en otro proceso. Por eso abre su
 * transaccion y setea `app.tenant_id` con `set_config(..., true)`, que es
 * SET LOCAL: muere con la transaccion y no se pega a la conexion del pool. Con
 * `SET` a secas el siguiente job heredaria el tenant del anterior, que en un
 * SaaS de empresas de seguridad es la fuga que no se puede permitir.
 *
 * RLS sigue aplicando: el worker usa el mismo rol sin BYPASSRLS que la API.
 */
@Processor(PUSH_QUEUE_NAME)
export class PushProcessor extends WorkerHost {
  private readonly logger = new Logger(PushProcessor.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(PUSH_PROVIDER) private readonly provider: PushProvider,
  ) {
    super();
  }

  async process(job: Job<PushJobData>): Promise<PushJobResult> {
    const { tenantId, userId, notification } = job.data;

    const filas = await this.enTenant<{ token: string }>(
      tenantId,
      `SELECT token FROM device_tokens
       WHERE tenant_id = app_tenant_id() AND user_id = $1
       ORDER BY last_seen_at DESC`,
      [userId],
    );
    const tokens = filas.map((f) => f.token);

    if (tokens.length === 0) {
      // No es una falla: hay destinatarios que solo usan el escritorio. Se
      // registra porque un supervisor de terreno sin dispositivos casi siempre
      // significa que nunca acepto el permiso de notificaciones.
      this.logger.log(
        JSON.stringify({ event: 'push_sin_dispositivos', tenant_id: tenantId, job_id: job.id }),
      );
      return { delivered: 0, removed: 0 };
    }

    const resultados = await this.provider.send(tokens, notification, tenantId);

    const invalidos = resultados
      .filter((r) => r.verdict === 'token-invalido')
      .map((r) => r.token);
    const entregados = resultados.filter((r) => r.verdict === 'entregado').length;
    const reintentables = resultados.filter((r) => r.verdict === 'reintentable').length;

    // Se borra ANTES de decidir si el job falla: la limpieza no puede quedar
    // colgada de que el reintento salga bien. Un token muerto que sobrevive
    // hace mas lento cada aviso siguiente.
    if (invalidos.length > 0) {
      await this.enTenant(
        tenantId,
        `DELETE FROM device_tokens
         WHERE tenant_id = app_tenant_id() AND token = ANY($1::text[])`,
        [invalidos],
      );
      this.logger.log(
        JSON.stringify({
          event: 'push_tokens_muertos_borrados',
          tenant_id: tenantId,
          count: invalidos.length,
        }),
      );
    }

    /**
     * Se reintenta SOLO si no llego a ningun dispositivo.
     *
     * Si al menos uno sono, el aviso cumplio su funcion; reintentar por el otro
     * telefono repetiria la notificacion en el que ya la mostro. Una alerta de
     * panico duplicada entrena a ignorar la siguiente, que es exactamente lo
     * contrario de para lo que existe.
     */
    if (entregados === 0 && reintentables > 0) {
      throw new Error('push_no_entregado');
    }

    return { delivered: entregados, removed: invalidos.length };
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<PushJobData> | undefined) {
    if (!job || job.attemptsMade < Number(job.opts.attempts ?? 1)) return;

    // Dead-letter: solo identificadores. Ni el token, ni el destinatario, ni el
    // texto del aviso.
    this.logger.error(
      JSON.stringify({
        event: 'push_dead_letter',
        tenant_id: job.data.tenantId,
        job_id: job.id,
        attempts: job.attemptsMade,
      }),
    );
  }

  private async enTenant<T>(
    tenantId: string,
    sql: string,
    parametros: unknown[],
  ): Promise<T[]> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    try {
      // Sin usuario: el worker no actua en nombre de nadie. Y sin acceso de
      // soporte: una ventana de soporte se abre para que una persona mire, no
      // para que un job de fondo escriba.
      await runner.manager.query(
        `SELECT
          set_config('app.tenant_id', $1, true),
          set_config('app.user_id', '', true),
          set_config('app.support_access_id', '', true)`,
        [tenantId],
      );
      const filas = await runner.manager.query<T[]>(sql, parametros);
      await runner.commitTransaction();
      return filas;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }
}
