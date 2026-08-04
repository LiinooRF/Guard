import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';
import type { DataSource } from 'typeorm';

import {
  BarridoEnvioService,
  ENVIO_BARRIDO_GRACIA_MIN,
  ENVIO_BARRIDO_INTERVALO_MS,
  ENVIO_BARRIDO_MAX_RONDAS,
  ENVIO_BARRIDO_SCHEDULER_ID,
  ENVIO_BARRIDO_VENTANA_H,
} from './envio-informe.barrido';
import type { EnvioInformeJobData } from './envio-informe.types';

/**
 * Tests del barrido de rondas sin informe (#86).
 *
 * Lo que se prueba es la DECISION del barrido: a que rondas rescata, con que
 * jobId las encola y que no se cae por una.
 *
 * El mock de `dataSource.query` devuelve un arreglo PLANO, que es lo que entrega
 * el driver de PostgreSQL para un SELECT. (Para UPDATE/DELETE devolveria
 * [filas, cantidad]; el barrido no corre ninguno, y por eso no lee `rowCount` en
 * ningun lado.)
 *
 * El mock de la cola de despachos replica el contrato REAL de BullMQ para el
 * jobId repetido: `add` con un jobId que ya existe NO crea un segundo job y
 * devuelve el que ya estaba (ver addStandardJob.lua -> handleDuplicatedJob), y
 * `getJob` lo encuentra. Si el mock aceptara los dos `add`, el test del jobId
 * estable estaria confirmando lo que el autor ya creia en vez de probar algo.
 *
 * LO QUE ESTOS TESTS NO PRUEBAN, y hay que mirar contra la base de verdad: que
 * `report_dispatch_backlog()` exista y filtre bien. El mock devuelve lo que se
 * le pida. Los nombres de columna de esa funcion estan verificados a mano contra
 * las migraciones (patrols.closed_at, patrols.status, tenants.status,
 * report_deliveries.tenant_id/patrol_id) y el TEXTO del SQL tiene su propio
 * test en envio-informe.backlog.migration.spec.ts, no en este archivo.
 */

const TENANT_A = 'a0000000-0000-4000-8000-000000000001';
const TENANT_B = 'a0000000-0000-4000-8000-000000000002';
const RONDA_1 = 'b0000000-0000-4000-8000-000000000011';
const RONDA_2 = 'b0000000-0000-4000-8000-000000000012';

interface Fixture {
  readonly rezagadas?: Array<{ tenant_id: string; patrol_id: string }>;
  /** Hace fallar el `add` de la ronda cuyo id venga aca. */
  readonly fallaAlEncolar?: string;
}

interface Encolado {
  readonly nombre: string;
  readonly data: EnvioInformeJobData;
  readonly jobId: string;
}

interface Consulta {
  readonly sql: string;
  readonly parametros: unknown[];
}

interface Programado {
  readonly id: string;
  readonly cada: number;
}

function armar(fixture: Fixture = {}) {
  // Los mocks anotan lo que reciben en vez de que el test lea `mock.calls` a
  // punta de casts: queda tipado, y una assertion sobre el jobId deja de
  // compilar si el servicio dejara de pasarlo.
  const consultas: Consulta[] = [];
  const dataSource = {
    query: jest.fn(async (sql: string, parametros: unknown[]) => {
      consultas.push({ sql, parametros });
      if (sql.includes('report_dispatch_backlog')) {
        return fixture.rezagadas ?? [];
      }
      throw new Error(`consulta no esperada: ${sql}`);
    }),
  };

  const programados: Programado[] = [];
  const agenda = {
    upsertJobScheduler: jest.fn(async (id: string, repeticion: { every: number }) => {
      programados.push({ id, cada: repeticion.every });
      return { id: 'sched-1' };
    }),
  };

  const encolados: Encolado[] = [];
  // La cola de verdad: un jobId ocupado no se puede volver a usar, y los jobs
  // se retienen al completarse (removeOnComplete: false).
  const enRedis = new Map<string, { id: string }>();
  const despachos = {
    getJob: jest.fn(async (jobId: string) => enRedis.get(jobId)),
    add: jest.fn(
      async (nombre: string, data: EnvioInformeJobData, opciones: { jobId: string }) => {
        if (fixture.fallaAlEncolar === data.patrolId) {
          throw new Error('redis caido');
        }
        const existente = enRedis.get(opciones.jobId);
        // BullMQ no crea un segundo job con el mismo jobId: devuelve el que ya
        // estaba, sin avisar que no agrego nada.
        if (existente) return existente;
        const job = { id: `job-${enRedis.size + 1}` };
        enRedis.set(opciones.jobId, job);
        encolados.push({ nombre, data, jobId: opciones.jobId });
        return job;
      },
    ),
  };

  const service = new BarridoEnvioService(
    agenda as unknown as Queue,
    despachos as unknown as Queue<EnvioInformeJobData>,
    dataSource as unknown as DataSource,
  );

  return { service, dataSource, despachos, consultas, encolados, programados };
}

/** El jobId que el barrido debe usar para una ronda. */
function jobIdBarrido(patrolId: string): string {
  return createHash('sha256').update(`envio-informe:barrido:${patrolId}`).digest('hex');
}

/** El jobId que uso el disparo normal al cerrarse la ronda. */
function jobIdCierre(patrolId: string): string {
  return createHash('sha256').update(`envio-informe:${patrolId}`).digest('hex');
}

describe('BarridoEnvioService', () => {
  describe('barrer', () => {
    it('encola un despacho por cada ronda cerrada que quedo sin informe', async () => {
      const { service, encolados } = armar({
        rezagadas: [
          { tenant_id: TENANT_A, patrol_id: RONDA_1 },
          { tenant_id: TENANT_B, patrol_id: RONDA_2 },
        ],
      });

      const resultado = await service.barrer();

      expect(resultado).toEqual({ rezagadas: 2, encoladas: 2, yaRescatadas: 0 });
      // Cada despacho viaja con SU tenant: el barrido cruza empresas, pero cada
      // job vuelve a entrar por el RLS de la suya.
      expect(encolados.map((e) => e.data)).toEqual([
        { tenantId: TENANT_A, patrolId: RONDA_1 },
        { tenantId: TENANT_B, patrolId: RONDA_2 },
      ]);
    });

    it('el jobId del rescate NO choca con el del disparo normal', async () => {
      const { service, encolados } = armar({
        rezagadas: [{ tenant_id: TENANT_A, patrol_id: RONDA_1 }],
      });

      await service.barrer();

      // Si reusara el jobId del cierre, BullMQ lo descartaria por duplicado
      // —justamente el jobId quemado que motiva el barrido— y la ronda se
      // quedaria sin informe para siempre.
      expect(encolados[0]?.jobId).not.toBe(jobIdCierre(RONDA_1));
      expect(encolados[0]?.jobId).toBe(jobIdBarrido(RONDA_1));
    });

    it('cada ronda recibe UN rescate, no uno por pasada', async () => {
      const { service, encolados } = armar({
        rezagadas: [{ tenant_id: TENANT_A, patrol_id: RONDA_1 }],
      });

      const primera = await service.barrer();
      const segunda = await service.barrer();

      // Un solo job en la cola despues de dos pasadas: el jobId del rescate es
      // estable y la cola ya no lo acepta de nuevo. Si esto fallara, una ronda
      // que el despacho no puede resolver acumularia un job cada diez minutos.
      expect(encolados).toHaveLength(1);
      expect(encolados[0]?.jobId).toBe(jobIdBarrido(RONDA_1));
      expect(primera).toEqual({ rezagadas: 1, encoladas: 1, yaRescatadas: 0 });
      // Y la segunda pasada NO la cuenta como encolada: contar un no-op como
      // rescate haria leer el log como si el camino normal estuviera perdiendo
      // rondas ahora mismo.
      expect(segunda).toEqual({ rezagadas: 1, encoladas: 0, yaRescatadas: 1 });
    });

    it('no deja identificadores de negocio legibles en Redis', async () => {
      const { service, encolados } = armar({
        rezagadas: [{ tenant_id: TENANT_A, patrol_id: RONDA_1 }],
      });

      await service.barrer();

      expect(encolados[0]?.jobId).toMatch(/^[0-9a-f]{64}$/);
      expect(encolados[0]?.jobId).not.toContain(RONDA_1);
    });

    it('sin rezagadas no encola nada', async () => {
      const { service, despachos } = armar({ rezagadas: [] });

      const resultado = await service.barrer();

      expect(resultado).toEqual({ rezagadas: 0, encoladas: 0, yaRescatadas: 0 });
      expect(despachos.add).not.toHaveBeenCalled();
    });

    it('deja el latido en el log tambien cuando no encontro nada', async () => {
      // Sin este log con cero, "el barrido corrio y no habia nada" y "el barrido
      // no corre hace dos dias" se ven exactamente igual desde afuera. Lo
      // segundo es posible: si Redis esta caido al arrancar, el programador
      // queda sin registrar hasta el proximo arranque.
      const escrito = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      try {
        const { service } = armar({ rezagadas: [] });

        await service.barrer();

        expect(escrito).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(escrito.mock.calls[0]?.[0]))).toEqual({
          event: 'informe_barrido',
          rezagadas: 0,
          encoladas: 0,
          ya_rescatadas: 0,
        });
      } finally {
        escrito.mockRestore();
      }
    });

    it('una ronda que no se puede encolar no corta el barrido', async () => {
      const { service, despachos, encolados } = armar({
        rezagadas: [
          { tenant_id: TENANT_A, patrol_id: RONDA_1 },
          { tenant_id: TENANT_B, patrol_id: RONDA_2 },
        ],
        fallaAlEncolar: RONDA_1,
      });

      const resultado = await service.barrer();

      // La segunda es de otra empresa y no tiene por que pagar el fallo de la
      // primera.
      expect(resultado).toEqual({ rezagadas: 2, encoladas: 1, yaRescatadas: 0 });
      expect(despachos.add).toHaveBeenCalledTimes(2);
      expect(encolados.map((e) => e.data.patrolId)).toEqual([RONDA_2]);
    });

    it('consulta el backlog con la gracia, la ventana y el tope configurados', async () => {
      const { service, consultas } = armar({ rezagadas: [] });

      await service.barrer();

      expect(consultas[0]?.sql).toContain('report_dispatch_backlog');
      expect(consultas[0]?.parametros).toEqual([
        ENVIO_BARRIDO_GRACIA_MIN,
        ENVIO_BARRIDO_VENTANA_H,
        ENVIO_BARRIDO_MAX_RONDAS,
      ]);
    });

    it('la gracia le deja terminar al despacho normal antes de pisarlo', () => {
      // El despacho normal reintenta 5 veces con espera exponencial desde 5 s:
      // puede tardar mas de un minuto. Si la gracia fuera menor, el barrido
      // dibujaria un PDF en paralelo al que todavia esta en vuelo.
      expect(ENVIO_BARRIDO_GRACIA_MIN * 60_000).toBeGreaterThan(ENVIO_BARRIDO_INTERVALO_MS / 2);
      expect(ENVIO_BARRIDO_GRACIA_MIN).toBeGreaterThanOrEqual(5);
    });
  });

  describe('onModuleInit', () => {
    it('programa el barrido con upsert, para que N replicas dejen UN programador', () => {
      const { service, programados } = armar();

      // No devuelve promesa a proposito: el arranque de la API no puede quedar
      // colgado esperando a Redis (ver el comentario de onModuleInit).
      service.onModuleInit();
      service.onModuleInit();

      // Mismo id en las dos llamadas: es un upsert, no un alta. Con dos replicas
      // de la API queda UN programador, no dos barridos en paralelo.
      expect(programados).toEqual([
        { id: ENVIO_BARRIDO_SCHEDULER_ID, cada: ENVIO_BARRIDO_INTERVALO_MS },
        { id: ENVIO_BARRIDO_SCHEDULER_ID, cada: ENVIO_BARRIDO_INTERVALO_MS },
      ]);
    });

    it('la ventana de rescate no revive rondas viejas', () => {
      // Rescatar una ronda de la semana pasada al reparar una caida larga es
      // ruido para el jefe de operaciones, no informacion.
      expect(ENVIO_BARRIDO_VENTANA_H).toBeLessThanOrEqual(72);
      expect(ENVIO_BARRIDO_VENTANA_H).toBeGreaterThanOrEqual(24);
    });
  });
});
