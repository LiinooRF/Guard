import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { DEFAULT_PATROL_RULES, PATROL_RULE_CATALOG, type PatrolRules } from '@voxia/shared';
import type { Queue } from 'bullmq';
import type { DataSource, QueryRunner } from 'typeorm';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';
import {
  AVISO_INICIO_INTERVALO_MS,
  AVISO_INICIO_MAX_ANTICIPACION_MIN,
  AVISO_INICIO_MAX_RONDAS,
  AVISO_INICIO_SCHEDULER_ID,
} from './aviso-inicio-ronda.constants';
import { AvisoInicioRondaService } from './aviso-inicio-ronda.service';
import type { PushNotification } from './push-provider';
import type { PushService } from './push.service';

/**
 * Tests del aviso de inicio de ronda (#43).
 *
 * Lo que se prueba es la DECISION del barrido: a que guardia le avisa, cuando,
 * con que contenido y con que clave de idempotencia. La entrega ya tiene sus
 * tests (push.processor.spec.ts) y no se repite aca.
 *
 * EL DOBLE DE TenantContextService NO ES UN OBJETO CON `query`. Guarda el
 * QueryRunner que recibe en `run()` y lo suelta al terminar, igual que el
 * AsyncLocalStorage real: asi, si alguien moviera una consulta fuera de la
 * transaccion del tenant, `manager` lanzaria como lanza en produccion en vez de
 * responder datos. Ese error —consultar sin contexto de tenant— es exactamente
 * el que un mock plano esconde.
 *
 * LO QUE ESTOS TESTS NO PRUEBAN, y hay que mirar contra la base de verdad: que
 * `patrol_start_notice_backlog()` exista y filtre bien; el doble devuelve lo que
 * se le pida. El TEXTO de ese SQL tiene su propio test en
 * aviso-inicio-ronda.migration.spec.ts, y los nombres de columna estan
 * verificados a mano contra las migraciones (patrols.status/is_voluntary/
 * guard_id/scheduled_start_at de 1722524400000 y 1724252400000, sites.name y
 * sites.timezone de 1722524400000, users.is_active de 1722350000000).
 */

const TENANT_A = 'a0000000-0000-4000-8000-000000000001';
const TENANT_B = 'a0000000-0000-4000-8000-000000000002';
const RONDA_1 = 'b0000000-0000-4000-8000-000000000011';
const RONDA_2 = 'b0000000-0000-4000-8000-000000000012';
const RECINTO = 'c0000000-0000-4000-8000-000000000021';
const GUARDIA = 'd0000000-0000-4000-8000-000000000031';

/** Minuto en milisegundos, para escribir las esperas sin ceros de mas. */
const MIN = 60_000;

interface RondaFixture {
  readonly id: string;
  readonly siteId?: string;
  readonly guardId?: string;
  /** Minutos que faltan para que arranque. */
  readonly enMinutos: number;
  readonly siteName?: string;
  readonly horaLocal?: string;
}

interface Fixture {
  readonly candidatas?: Array<{ tenant_id: string; patrol_id: string }>;
  readonly rondas?: Record<string, RondaFixture[]>;
  /**
   * Anticipacion configurada por recinto. `undefined` = la empresa no la tiene
   * escrita y manda el default del puente (ver aviso-inicio-ronda.service.ts).
   */
  readonly anticipacionMin?: number;
  /** Hace fallar la lectura de rondas de esta empresa. */
  readonly fallaEmpresa?: string;
}

/**
 * Reglas efectivas. `patrolStartNoticeMin` todavia no esta en PatrolRules —el
 * diff de rules.ts va en INTEGRACION.md— y por eso se agrega con una conversion
 * explicita: es la MISMA situacion que atiende el puente del servicio, y el test
 * cubre los dos lados (con la clave y sin ella).
 */
function reglasCon(anticipacionMin: number | undefined): PatrolRules {
  if (anticipacionMin === undefined) return DEFAULT_PATROL_RULES;
  return {
    ...DEFAULT_PATROL_RULES,
    patrolStartNoticeMin: anticipacionMin,
  } as unknown as PatrolRules;
}

interface Consulta {
  readonly sql: string;
  readonly parametros: unknown[];
}

interface Envio {
  readonly destinatarios: readonly string[];
  readonly aviso: PushNotification;
  readonly clave: string;
}

function armar(fixture: Fixture = {}) {
  const cruzaEmpresas: Consulta[] = [];
  const enEmpresa: Consulta[] = [];

  // El manager de la transaccion de tenant. Responde SQL_RONDAS y nada mas.
  const managerDeTenant = {
    query: jest.fn(async (sql: string, parametros: unknown[]) => {
      enEmpresa.push({ sql, parametros });
      if (sql.includes('set_config')) return [];
      if (!sql.includes('FROM patrols')) throw new Error(`consulta no esperada: ${sql}`);
      // El servicio manda UN parametro: el arreglo de ids para `= ANY($1)`.
      const ids = parametros[0] as string[];
      const tenant = [...(fixture.candidatas ?? [])].find((c) => ids.includes(c.patrol_id));
      const empresa = tenant?.tenant_id ?? '';
      if (fixture.fallaEmpresa === empresa) throw new Error('base caida');
      return (fixture.rondas?.[empresa] ?? [])
        .filter((r) => ids.includes(r.id))
        .map((r) => ({
          id: r.id,
          site_id: r.siteId ?? RECINTO,
          guard_id: r.guardId ?? GUARDIA,
          scheduled_start_at: new Date(Date.now() + r.enMinutos * MIN),
          site_name: r.siteName ?? 'Planta Sur',
          hora_local: r.horaLocal ?? '22:00',
        }));
    }),
  };

  const runners: Array<{ commit: boolean; rollback: boolean }> = [];
  const runner = () => {
    const marca = { commit: false, rollback: false };
    runners.push(marca);
    return {
      connect: jest.fn(),
      startTransaction: jest.fn(),
      commitTransaction: jest.fn(async () => {
        marca.commit = true;
      }),
      rollbackTransaction: jest.fn(async () => {
        marca.rollback = true;
      }),
      release: jest.fn(),
      manager: managerDeTenant,
    } as unknown as QueryRunner;
  };

  const dataSource = {
    query: jest.fn(async (sql: string, parametros: unknown[]) => {
      cruzaEmpresas.push({ sql, parametros });
      if (!sql.includes('patrol_start_notice_backlog')) {
        throw new Error(`consulta no esperada: ${sql}`);
      }
      return fixture.candidatas ?? [];
    }),
    createQueryRunner: jest.fn(runner),
  } as unknown as DataSource;

  // El doble del contexto: solo hay manager DENTRO de run(), como en produccion.
  let abierto: QueryRunner | null = null;
  const contexto = {
    run: jest.fn(async (queryRunner: QueryRunner, operacion: () => Promise<unknown>) => {
      abierto = queryRunner;
      try {
        return await operacion();
      } finally {
        abierto = null;
      }
    }),
    get manager() {
      if (!abierto) throw new Error('No existe una transaccion asociada al contexto tenant actual');
      return abierto.manager;
    },
  } as unknown as TenantContextService;

  const recintosConsultados: Array<string | null | undefined> = [];
  const rules = {
    effective: jest.fn(async (contextoRegla: { siteId?: string | null }) => {
      recintosConsultados.push(contextoRegla.siteId);
      return reglasCon(fixture.anticipacionMin);
    }),
  } as unknown as RulesService;

  const envios: Envio[] = [];
  const push = {
    send: jest.fn(
      async (
        destinatarios: readonly string[],
        aviso: PushNotification,
        opciones: { idempotencyKey: string },
      ) => {
        envios.push({ destinatarios, aviso, clave: opciones.idempotencyKey });
        return { enqueued: destinatarios.length };
      },
    ),
  } as unknown as PushService;

  const programados: Array<{ id: string; cada: number }> = [];
  const agenda = {
    upsertJobScheduler: jest.fn(async (id: string, repeticion: { every: number }) => {
      programados.push({ id, cada: repeticion.every });
      return { id: 'sched-1' };
    }),
  } as unknown as Queue;

  const service = new AvisoInicioRondaService(agenda, dataSource, contexto, rules, push);

  return {
    service,
    cruzaEmpresas,
    enEmpresa,
    envios,
    programados,
    runners,
    recintosConsultados,
    agenda,
  };
}

describe('AvisoInicioRondaService — programacion', () => {
  it('deja UN programador idempotente, no uno por replica', async () => {
    const { service, programados } = armar();

    service.onModuleInit();
    await Promise.resolve();

    expect(programados).toEqual([
      { id: AVISO_INICIO_SCHEDULER_ID, cada: AVISO_INICIO_INTERVALO_MS },
    ]);
  });

  it('si Redis esta caido el arranque no se cae: una API que no arranca es un guardia que no puede escanear', async () => {
    const { service, agenda } = armar();
    (agenda.upsertJobScheduler as jest.Mock).mockRejectedValueOnce(new Error('redis caido'));

    expect(() => service.onModuleInit()).not.toThrow();
    await Promise.resolve();
  });
});

describe('AvisoInicioRondaService — barrido', () => {
  it('pide las rondas por comenzar con el techo del catalogo y el tope de la pasada', async () => {
    const { service, cruzaEmpresas } = armar();

    await expect(service.barrer()).resolves.toEqual({
      candidatas: 0,
      empresas: 0,
      avisadas: 0,
    });

    expect(cruzaEmpresas[0]?.parametros).toEqual([
      AVISO_INICIO_MAX_ANTICIPACION_MIN,
      AVISO_INICIO_MAX_RONDAS,
    ]);
  });

  it('avisa al guardia de la ronda que ya entro en la ventana', async () => {
    const { service, envios } = armar({
      candidatas: [{ tenant_id: TENANT_A, patrol_id: RONDA_1 }],
      rondas: { [TENANT_A]: [{ id: RONDA_1, enMinutos: 8 }] },
      anticipacionMin: 10,
    });

    await expect(service.barrer()).resolves.toEqual({
      candidatas: 1,
      empresas: 1,
      avisadas: 1,
    });

    // Al GUARDIA de esa ronda, no al supervisor: este aviso mira hacia adelante
    // y su destinatario es quien la tiene que hacer.
    expect(envios[0]?.destinatarios).toEqual([GUARDIA]);
    expect(envios[0]?.aviso.deepLink).toEqual({
      destino: 'ronda',
      id: RONDA_1,
      siteId: RECINTO,
    });
    // `alta` es urgencia del transporte: es lo unico que atraviesa Doze, y este
    // aviso se vence a una hora exacta.
    expect(envios[0]?.aviso.urgency).toBe('alta');
    expect(envios[0]?.aviso.collapseKey).toBe(`inicio-ronda:${RONDA_1}`);
  });

  it('el aviso no lleva datos de personas: se lee en una pantalla bloqueada', async () => {
    const { service, envios } = armar({
      candidatas: [{ tenant_id: TENANT_A, patrol_id: RONDA_1 }],
      rondas: {
        [TENANT_A]: [
          { id: RONDA_1, enMinutos: 3, siteName: 'Planta Sur', horaLocal: '22:00' },
        ],
      },
      anticipacionMin: 10,
    });

    await service.barrer();

    const texto = `${envios[0]?.aviso.title} ${envios[0]?.aviso.body}`;
    expect(envios[0]?.aviso.body).toBe('Planta Sur: comienza a las 22:00.');
    // Ni el nombre del guardia, ni su id, ni la ruta, ni los puntos.
    expect(texto).not.toContain(GUARDIA);
    expect(texto).not.toContain(RONDA_1);
  });

  it('la hora sale de la base, en el huso del recinto', async () => {
    const { service, enEmpresa } = armar({
      candidatas: [{ tenant_id: TENANT_A, patrol_id: RONDA_1 }],
      rondas: { [TENANT_A]: [{ id: RONDA_1, enMinutos: 5 }] },
    });

    await service.barrer();

    const rondas = enEmpresa.find((c) => c.sql.includes('FROM patrols'));
    // Una ronda de las 22:00 avisada como "02:00" (UTC) es peor que no avisar.
    expect(rondas?.sql).toContain('AT TIME ZONE s.timezone');
    expect(rondas?.sql).toContain('to_char(');
    // El guardia dado de baja no recibe nada, ya desde el origen.
    expect(rondas?.sql).toContain('u.is_active');
    // Las voluntarias son cobertura extra que el guardia decidio hacer: no hay
    // nada programado que recordarle.
    expect(rondas?.sql).toContain('NOT p.is_voluntary');
  });

  it('la clave de idempotencia identifica la ronda, no la pasada', async () => {
    const { service, envios } = armar({
      candidatas: [{ tenant_id: TENANT_A, patrol_id: RONDA_1 }],
      rondas: { [TENANT_A]: [{ id: RONDA_1, enMinutos: 5 }] },
    });

    // Dos pasadas seguidas: la misma clave las dos veces, y BullMQ descarta la
    // segunda. Sin esto el guardia recibiria un aviso cada dos minutos durante
    // toda la ventana de anticipacion.
    await service.barrer();
    await service.barrer();

    expect(envios.map((e) => e.clave)).toEqual([
      `patrol-start:${RONDA_1}`,
      `patrol-start:${RONDA_1}`,
    ]);
  });

  it('no avisa antes de tiempo: la ronda lejana espera a la pasada que corresponde', async () => {
    const { service, envios } = armar({
      candidatas: [
        { tenant_id: TENANT_A, patrol_id: RONDA_1 },
        { tenant_id: TENANT_A, patrol_id: RONDA_2 },
      ],
      rondas: {
        [TENANT_A]: [
          { id: RONDA_1, enMinutos: 9 },
          { id: RONDA_2, enMinutos: 45 },
        ],
      },
      anticipacionMin: 10,
    });

    const resultado = await service.barrer();

    expect(resultado).toEqual({ candidatas: 2, empresas: 1, avisadas: 1 });
    expect(envios).toHaveLength(1);
    expect(envios[0]?.aviso.deepLink.id).toBe(RONDA_1);
  });

  it('anticipacion en cero es el aviso apagado, no "avisar al instante"', async () => {
    const { service, envios } = armar({
      candidatas: [{ tenant_id: TENANT_A, patrol_id: RONDA_1 }],
      rondas: { [TENANT_A]: [{ id: RONDA_1, enMinutos: 0 }] },
      anticipacionMin: 0,
    });

    await expect(service.barrer()).resolves.toEqual({
      candidatas: 1,
      empresas: 1,
      avisadas: 0,
    });
    expect(envios).toEqual([]);
  });

  it('sin la clave en el catalogo todavia, manda el default del puente', async () => {
    // 12 minutos: fuera de los 10 del puente. Si el puente devolviera NaN o 0
    // —que es lo que pasaria leyendo la clave inexistente sin proteccion— este
    // caso avisaria o no avisaria por accidente.
    const lejos = armar({
      candidatas: [{ tenant_id: TENANT_A, patrol_id: RONDA_1 }],
      rondas: { [TENANT_A]: [{ id: RONDA_1, enMinutos: 12 }] },
    });
    await expect(lejos.service.barrer()).resolves.toMatchObject({ avisadas: 0 });

    const cerca = armar({
      candidatas: [{ tenant_id: TENANT_A, patrol_id: RONDA_1 }],
      rondas: { [TENANT_A]: [{ id: RONDA_1, enMinutos: 6 }] },
    });
    await expect(cerca.service.barrer()).resolves.toMatchObject({ avisadas: 1 });
  });

  it('resuelve las reglas POR RECINTO y no repite la cascada del mismo recinto', async () => {
    const otroRecinto = 'c0000000-0000-4000-8000-000000000022';
    const { service, recintosConsultados } = armar({
      candidatas: [
        { tenant_id: TENANT_A, patrol_id: RONDA_1 },
        { tenant_id: TENANT_A, patrol_id: RONDA_2 },
      ],
      rondas: {
        [TENANT_A]: [
          { id: RONDA_1, enMinutos: 4 },
          { id: RONDA_2, enMinutos: 4, siteId: otroRecinto },
        ],
      },
    });

    await service.barrer();

    expect(recintosConsultados).toEqual([RECINTO, otroRecinto]);
  });

  it('cada empresa va en su transaccion, con SET LOCAL y sin usuario', async () => {
    const { service, enEmpresa, runners } = armar({
      candidatas: [
        { tenant_id: TENANT_A, patrol_id: RONDA_1 },
        { tenant_id: TENANT_B, patrol_id: RONDA_2 },
      ],
      rondas: {
        [TENANT_A]: [{ id: RONDA_1, enMinutos: 4 }],
        [TENANT_B]: [{ id: RONDA_2, enMinutos: 4 }],
      },
    });

    await expect(service.barrer()).resolves.toMatchObject({ empresas: 2, avisadas: 2 });

    const contextos = enEmpresa.filter((c) => c.sql.includes('set_config'));
    expect(contextos).toHaveLength(2);
    // SET LOCAL: muere con la transaccion. Con `SET` a secas la empresa
    // siguiente heredaria el tenant de la anterior sobre el mismo pool.
    expect(contextos[0]?.sql).toContain(`set_config('app.tenant_id', $1, true)`);
    expect(contextos[0]?.sql).toContain(`set_config('app.user_id', '', true)`);
    expect(contextos[0]?.sql).toContain(`set_config('app.support_access_id', '', true)`);
    expect(contextos.map((c) => c.parametros)).toEqual([[TENANT_A], [TENANT_B]]);
    expect(runners.every((r) => r.commit)).toBe(true);
  });

  it('una empresa que falla no deja sin aviso a las demas', async () => {
    const { service, envios, runners } = armar({
      candidatas: [
        { tenant_id: TENANT_A, patrol_id: RONDA_1 },
        { tenant_id: TENANT_B, patrol_id: RONDA_2 },
      ],
      rondas: {
        [TENANT_A]: [{ id: RONDA_1, enMinutos: 4 }],
        [TENANT_B]: [{ id: RONDA_2, enMinutos: 4 }],
      },
      fallaEmpresa: TENANT_A,
    });

    await expect(service.barrer()).resolves.toEqual({
      candidatas: 2,
      empresas: 2,
      avisadas: 1,
    });

    expect(envios).toHaveLength(1);
    expect(envios[0]?.aviso.deepLink.id).toBe(RONDA_2);
    // La que fallo revierte su transaccion; la otra confirma la suya.
    expect(runners[0]?.rollback).toBe(true);
    expect(runners[1]?.commit).toBe(true);
  });

  it('una empresa sin rondas vigentes no encola nada aunque la funcion la trajera', async () => {
    // Entre la consulta cruza-empresas y la de la empresa pasan milisegundos, y
    // en esos milisegundos el guardia pudo haber iniciado la ronda.
    const { service, envios } = armar({
      candidatas: [{ tenant_id: TENANT_A, patrol_id: RONDA_1 }],
      rondas: { [TENANT_A]: [] },
    });

    await expect(service.barrer()).resolves.toEqual({
      candidatas: 1,
      empresas: 1,
      avisadas: 0,
    });
    expect(envios).toEqual([]);
  });
});

/**
 * El modulo mas correcto del mundo no avisa nada si nadie lo importa.
 *
 * No es un temor teorico: en este backlog ya aparecio una pantalla entera que
 * existia y que no importaba nadie. Un barrido que no esta en AppModule no
 * arranca su programador, no falla, no aparece en ningun log —el latido de
 * `aviso_inicio_barrido` tampoco se emite— y el sintoma es "a los guardias no
 * les llega el aviso", sin una sola linea roja en ningun lado.
 *
 * Se revisa sobre el TEXTO, con el mismo criterio que migrations.spec.ts: para
 * compilar el modulo de verdad haria falta Redis y una base, y este test tiene
 * que correr en cada push.
 */
describe('cableado del modulo', () => {
  const APP_MODULE = readFileSync(join(__dirname, '../app.module.ts'), 'utf8');

  it('AppModule importa AvisoInicioRondaModule', () => {
    expect(APP_MODULE).toContain(
      "import { AvisoInicioRondaModule } from './push/aviso-inicio-ronda.module'",
    );
    // Importar el simbolo no basta: tiene que estar en la lista de imports.
    expect(APP_MODULE).toMatch(/imports:\s*\[[\s\S]*\bAvisoInicioRondaModule,[\s\S]*\]/);
  });
});

/**
 * El techo del barrido y el maximo de la regla tienen que ser el MISMO numero.
 *
 * El barrido corre sin tenant y no puede leer la regla de cada empresa: trae
 * todo lo que empieza dentro de `AVISO_INICIO_MAX_ANTICIPACION_MIN` y el filtro
 * fino se aplica adentro. Si el catalogo permitiera una anticipacion mayor que
 * ese techo, la empresa que la configure NO recibiria el aviso nunca, y el
 * sintoma seria "a nosotros no nos llega" sin un error en ningun log.
 *
 * La ficha se busca a mano y no por tipo porque `patrolStartNoticeMin` entra a
 * PatrolRules con el diff de rules.ts (INTEGRACION.md), que aplica el
 * integrador: mientras no este, no hay nada que comparar y el test lo dice en
 * vez de fallar por algo que todavia no existe.
 */
describe('techo de anticipacion', () => {
  const ficha = (PATROL_RULE_CATALOG as unknown as Record<string, { max?: number } | undefined>)
    .patrolStartNoticeMin;

  it('coincide con el maximo de la ficha del catalogo', () => {
    if (!ficha) {
      expect(AVISO_INICIO_MAX_ANTICIPACION_MIN).toBe(120);
      return;
    }
    expect(ficha.max).toBe(AVISO_INICIO_MAX_ANTICIPACION_MIN);
  });
});
