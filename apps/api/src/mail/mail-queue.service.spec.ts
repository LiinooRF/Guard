import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';

import { resolverDominiosNoDespachables } from './mail-dominios';
import {
  MAIL_JOB_ATTEMPTS,
  MAIL_JOB_BACKOFF_MS,
  MAIL_JOB_NAME,
} from './mail-queue.constants';
import { MailQueueService } from './mail-queue.service';
import type { MailJobData } from './mail-queue.types';

/**
 * La lista de FABRICA, la misma que arma el modulo con el entorno vacio. Los
 * tests corren contra la configuracion real y no contra una lista inventada:
 * si el default dejara de proteger, aca se cae.
 */
const DE_FABRICA = resolverDominiosNoDespachables({});

/**
 * Un destinatario de verdad. Antes este archivo usaba `admin@example.test`, que
 * hoy queda suprimido por norma (RFC 2606): con esa direccion los tests de la
 * mecanica de la cola no probarian la mecanica de la cola.
 */
const data: MailJobData = {
  to: 'jefa@empresa.cl',
  tenantId: '00000000-0000-4000-8000-000000000001',
  template: { subject: 'Informe', text: 'Listo' },
  variables: {},
};

describe('MailQueueService', () => {
  it('encola fuera del request con reintentos, backoff y retencion', async () => {
    const queue = {
      add: jest.fn().mockResolvedValue({ id: 'job-id' }),
    } as unknown as Queue<MailJobData>;
    const service = new MailQueueService(queue, DE_FABRICA);

    await expect(
      service.enqueue(data, { idempotencyKey: 'report:patrol-1:admin-1' }),
    ).resolves.toEqual({ estado: 'encolado', jobId: 'job-id' });

    expect(queue.add).toHaveBeenCalledWith(
      MAIL_JOB_NAME,
      data,
      expect.objectContaining({
        attempts: MAIL_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: MAIL_JOB_BACKOFF_MS },
        removeOnComplete: false,
        removeOnFail: false,
      }),
    );
  });

  it('produce el mismo job id sin exponer la clave de negocio', async () => {
    const add = jest.fn().mockImplementation(
      (_name: string, _data: MailJobData, options: { jobId: string }) =>
        Promise.resolve({ id: options.jobId }),
    );
    const service = new MailQueueService({ add } as unknown as Queue<MailJobData>, DE_FABRICA);
    const idempotencyKey = 'report:patrol-1:admin@empresa.cl';
    const expected = createHash('sha256').update(idempotencyKey).digest('hex');

    const first = await service.enqueue(data, { idempotencyKey });
    const second = await service.enqueue(data, { idempotencyKey });

    expect(first).toEqual({ estado: 'encolado', jobId: expected });
    expect(second).toEqual({ estado: 'encolado', jobId: expected });
    expect(expected).not.toContain('admin');
  });

  it('expone fallidos a soporte sin destinatario ni contenido', async () => {
    const queue = {
      getJobCounts: jest.fn().mockResolvedValue({ waiting: 1, failed: 1 }),
      getJobs: jest.fn().mockResolvedValue([
        {
          id: 'failed-job',
          data,
          attemptsMade: MAIL_JOB_ATTEMPTS,
          finishedOn: 1_725_000_000_000,
        },
      ]),
    } as unknown as Queue<MailJobData>;
    const status = await new MailQueueService(queue, DE_FABRICA).supportStatus();

    expect(status).toEqual({
      counts: { waiting: 1, failed: 1 },
      failed: [{
        jobId: 'failed-job',
        tenantId: data.tenantId,
        attemptsMade: MAIL_JOB_ATTEMPTS,
        finishedOn: 1_725_000_000_000,
      }],
    });
    expect(JSON.stringify(status)).not.toContain(data.to);
    expect(JSON.stringify(status)).not.toContain(data.template.text);
  });

  /**
   * La supresion por dominio (#86).
   *
   * Esta es la unica puerta por la que sale correo del producto: informes,
   * invitaciones, recuperacion de contrasena, escalamiento y checklists. Lo que
   * se prueba aca es que la cuenta demo no recibe NADA con la configuracion de
   * fabrica, y que el correo de un cliente de verdad sigue saliendo.
   */
  describe('supresion por dominio no despachable', () => {
    function conCola(dominios: readonly string[] = DE_FABRICA) {
      const add = jest.fn().mockResolvedValue({ id: 'job-id' });
      const service = new MailQueueService({ add } as unknown as Queue<MailJobData>, dominios);
      return { add, service };
    }

    it('no encola nada para la cuenta demo, sin configurar nada', async () => {
      const { add, service } = conCola();

      const resultado = await service.enqueue(
        { ...data, to: 'admin@demo-andina.test' },
        { idempotencyKey: 'invitation:abc' },
      );

      expect(resultado).toEqual({ estado: 'suprimido', motivo: 'dominio_bloqueado' });
      // Lo importante no es el valor devuelto: es que Redis no se toco. Un job
      // creado quema un jobId que no se puede reciclar.
      expect(add).not.toHaveBeenCalled();
    });

    it('el resultado suprimido NO trae jobId: el compilador obliga a mirarlo', async () => {
      const { service } = conCola();

      const resultado = await service.enqueue(
        { ...data, to: 'admin@demo-andina.test' },
        { idempotencyKey: 'invitation:abc' },
      );

      // Sin esta guarda, `resultado.jobId` no compila — que es justamente el
      // punto: quien anota el envio en su bitacora no puede hacerlo por
      // descuido.
      expect(resultado.estado).toBe('suprimido');
      expect(resultado).not.toHaveProperty('jobId');
    });

    it('una direccion sin dominio se distingue de una cuenta de prueba', async () => {
      // No es lo mismo "esto es una casilla demo" que "esto es un dato malo en
      // la base": son dos problemas con dos arreglos distintos.
      const { add, service } = conCola();

      await expect(
        service.enqueue({ ...data, to: 'sin-arroba' }, { idempotencyKey: 'x:1' }),
      ).resolves.toEqual({ estado: 'suprimido', motivo: 'sin_dominio' });
      expect(add).not.toHaveBeenCalled();
    });

    it('el cliente que paga sigue recibiendo', async () => {
      const { add, service } = conCola();

      await expect(
        service.enqueue({ ...data, to: 'jefa@empresa.cl' }, { idempotencyKey: 'x:2' }),
      ).resolves.toEqual({ estado: 'encolado', jobId: 'job-id' });
      expect(add).toHaveBeenCalledTimes(1);
    });

    it('no bloquea por parecido de texto', async () => {
      const { service } = conCola();

      for (const destinatario of ['a@mitest.cl', 'a@test.cl', 'a@protest.com', 'a@example.cl']) {
        await expect(
          service.enqueue({ ...data, to: destinatario }, { idempotencyKey: `x:${destinatario}` }),
        ).resolves.toMatchObject({ estado: 'encolado' });
      }
    });

    it('el log de supresion no lleva la direccion ni la clave de idempotencia', async () => {
      // CLAUDE.md, regla 5: los logs llevan tenant_id, no datos de personas. La
      // clave de idempotencia lleva el correo adentro, asi que tampoco entra.
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const { service } = conCola();

      await service.enqueue(
        { ...data, to: 'admin@demo-andina.test' },
        { idempotencyKey: 'report-dispatch:informe:ronda-1:admin@demo-andina.test' },
      );

      const lineas = warn.mock.calls.map((llamada) => String(llamada[0]));
      expect(lineas).toHaveLength(1);
      expect(lineas[0]).not.toContain('@');
      expect(lineas[0]).not.toContain('demo-andina');
      expect(JSON.parse(lineas[0] ?? '{}')).toEqual({
        event: 'correo_suprimido',
        tenant_id: data.tenantId,
        motivo: 'dominio_bloqueado',
        // La regla que bloqueo, que es un valor de la configuracion y no de una
        // persona. Es lo que contesta "¿por que no salio?" sin filtrar nada.
        regla: 'test',
      });

      warn.mockRestore();
    });

    it('con la escotilla abierta, la lista propia del equipo sigue bloqueando', async () => {
      // MAIL_ALLOW_RESERVED_DOMAINS no es el interruptor de encendido de la
      // supresion: decide si entran los reservados por norma, nada mas.
      const { add, service } = conCola(
        resolverDominiosNoDespachables({
          MAIL_ALLOW_RESERVED_DOMAINS: 'true',
          MAIL_BLOCKED_DOMAINS: 'demo-andina.cl',
        }),
      );

      await expect(
        service.enqueue({ ...data, to: 'a@demo-andina.cl' }, { idempotencyKey: 'x:3' }),
      ).resolves.toMatchObject({ estado: 'suprimido' });
      await expect(
        service.enqueue({ ...data, to: 'a@demo-andina.test' }, { idempotencyKey: 'x:4' }),
      ).resolves.toMatchObject({ estado: 'encolado' });
      expect(add).toHaveBeenCalledTimes(1);
    });

    it('un destinatario vacio sigue siendo un error del llamador, no una supresion', async () => {
      // Suprimir en silencio un `to` vacio taparia un bug de quien llama. La
      // supresion es para direcciones validas que no se deben despachar.
      const { service } = conCola();
      await expect(
        service.enqueue({ ...data, to: '  ' }, { idempotencyKey: 'x:5' }),
      ).rejects.toThrow('El destinatario de correo es obligatorio');
    });
  });
});
