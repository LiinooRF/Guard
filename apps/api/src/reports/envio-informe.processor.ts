import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { DataSource } from 'typeorm';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { ENVIO_INFORME_QUEUE_NAME } from './envio-informe.constants';
import { EnvioInformeService } from './envio-informe.service';
import type { EnvioInformeJobData, ResultadoEnvio } from './envio-informe.types';

/**
 * Worker del envio automatico del informe (#86).
 *
 * POR QUE ABRE SU PROPIA TRANSACCION CON CONTEXTO DE TENANT
 * `TenantContextService` vive en el AsyncLocalStorage que arma el interceptor a
 * partir del request. Aca no hay request: el job corre despues, en otro tick y
 * —el dia que haya mas de una replica— en otro proceso. Por eso abre su
 * transaccion y setea `app.tenant_id` con `set_config(..., true)`, que es
 * SET LOCAL: muere con la transaccion y no se pega a la conexion del pool. Con
 * `SET` a secas el siguiente job heredaria el tenant del anterior, y en un SaaS
 * de empresas de seguridad esa es la fuga que no se puede permitir.
 *
 * RLS sigue aplicando: el worker usa el mismo rol sin BYPASSRLS que la API.
 *
 * TODO EL DESPACHO VA EN UNA SOLA TRANSACCION, incluido el dibujo del PDF. Es
 * deliberado: si algo falla a mitad de camino, las filas de la bitacora vuelven
 * atras completas y el reintento vuelve a intentar con TODOS los destinatarios.
 * Lo que no vuelve atras son los correos ya encolados —Redis no participa de la
 * transaccion—, y por eso cada correo lleva su propia clave de idempotencia: el
 * reintento los vuelve a encolar y BullMQ no los entrega de nuevo.
 */
@Processor(ENVIO_INFORME_QUEUE_NAME)
export class EnvioInformeProcessor extends WorkerHost {
  private readonly logger = new Logger(EnvioInformeProcessor.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly contexto: TenantContextService,
    private readonly envio: EnvioInformeService,
  ) {
    super();
  }

  async process(job: Job<EnvioInformeJobData>): Promise<ResultadoEnvio> {
    const { tenantId, patrolId } = job.data;

    const resultado = await this.enTenant(tenantId, () =>
      this.envio.despachar(tenantId, patrolId),
    );

    /**
     * La ronda todavia no figura cerrada: se REINTENTA, no se descarta.
     *
     * El job se encola dentro de la transaccion del escaneo, y Redis no espera a
     * que esa transaccion confirme. En el peor caso el worker toma el job un
     * instante antes de que el cierre sea visible. Rendirse aca dejaria la ronda
     * sin informe para siempre, porque el jobId es unico por ronda y no se puede
     * volver a encolar. El backoff exponencial cubre de sobra ese desfase.
     */
    if (resultado.omitido === 'ronda_sin_cerrar') {
      throw new Error('ronda_sin_cerrar');
    }

    if (resultado.omitido !== null) {
      // Sin datos de personas: por que no se envio, y de que ronda.
      this.logger.log(
        JSON.stringify({
          event: 'informe_no_despachado',
          tenant_id: tenantId,
          patrol_id: patrolId,
          motivo: resultado.omitido,
        }),
      );
    }

    return resultado;
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<EnvioInformeJobData> | undefined) {
    if (!job || job.attemptsMade < Number(job.opts.attempts ?? 1)) return;

    // Dead-letter: solo identificadores. Ni destinatarios, ni recinto, ni
    // guardia. Con el patrol_id, soporte reencola desde el panel de la cola.
    this.logger.error(
      JSON.stringify({
        event: 'informe_dead_letter',
        tenant_id: job.data.tenantId,
        patrol_id: job.data.patrolId,
        job_id: job.id,
        attempts: job.attemptsMade,
      }),
    );
  }

  private async enTenant<T>(tenantId: string, operacion: () => Promise<T>): Promise<T> {
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
      const resultado = await this.contexto.run(runner, operacion);
      await runner.commitTransaction();
      return resultado;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }
}
