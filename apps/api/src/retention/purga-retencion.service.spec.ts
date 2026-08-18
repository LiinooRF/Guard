import { DEFAULT_PATROL_RULES, type PatrolRules } from '@sentrycore/shared';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Queue } from 'bullmq';
import type { DataSource, QueryRunner } from 'typeorm';
import type { ConfigService } from '@nestjs/config';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';
import {
  PURGA_LOTE_FOTOS,
  PURGA_MAX_FOTOS_POR_TENANT,
  PURGA_MAX_TRABADAS_POR_TENANT,
} from './purga-retencion.constantes';
import { PurgaRetencionService, retencionFotosDeNovedades } from './purga-retencion.service';

const EMPRESA_A = 'a0000000-0000-4000-8000-000000000001';
const EMPRESA_B = 'b0000000-0000-4000-8000-000000000001';

interface FotoFalsa {
  foto_id: string;
  ruta_relativa: string;
  peso_bytes: string;
}

interface OpcionesEntorno {
  tenants?: string[];
  reglas?: Partial<PatrolRules>;
  /** Lotes que va devolviendo `retencion_fotos_vencidas`, en orden. */
  lotesDeFotos?: FotoFalsa[][];
  /**
   * Fotos vencidas de la empresa, como si fueran la tabla. Con esto el mock
   * respeta el `excluir` de verdad en vez de devolver un guion escrito: es la
   * unica forma de que el test pueda distinguir "el servicio excluye" de "el
   * test dice que excluye".
   */
  tablaDeFotos?: FotoFalsa[];
  trazasPorLote?: number[];
  /** Empresas cuya lectura de reglas revienta. */
  reglasQueFallan?: string[];
  /** Empresas cuya marca de barrido revienta. */
  marcasQueFallan?: string[];
}

/**
 * Respuestas del driver en la forma REAL.
 *
 * Todo lo que hace este servicio son `SELECT ... FROM funcion(...)`, asi que
 * todo devuelve un arreglo plano de filas. Es justamente por lo que no hay
 * ningun DELETE suelto: en TypeORM un DELETE devuelve [filas, rowCount] y
 * leerlo como arreglo cuenta 2 siempre.
 */
function crearEntorno(opciones: OpcionesEntorno = {}) {
  const tenants = opciones.tenants ?? [EMPRESA_A];
  const lotes = [...(opciones.lotesDeFotos ?? [])];
  const trazas = [...(opciones.trazasPorLote ?? [0])];
  const reglasQueFallan = new Set(opciones.reglasQueFallan ?? []);
  const marcasQueFallan = new Set(opciones.marcasQueFallan ?? []);
  const tabla = opciones.tablaDeFotos ? [...opciones.tablaDeFotos] : null;
  const marcados: string[] = [];

  const query: jest.Mock = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('retencion_tenants')) {
      return tenants.map((tenant_id) => ({ tenant_id }));
    }
    if (sql.includes('retencion_marcar_barrido')) {
      const tenantId = String(params[0] ?? '');
      if (marcasQueFallan.has(tenantId)) throw new Error('marca ilegible');
      marcados.push(tenantId);
      return [{ retencion_marcar_barrido: null }];
    }
    if (sql.includes('retencion_purgar_trazas')) {
      return [{ retencion_purgar_trazas: trazas.shift() ?? 0 }];
    }
    if (sql.includes('retencion_fotos_vencidas')) {
      if (tabla) {
        // Lo que hace la funcion de verdad: las mas viejas primero, sin las
        // excluidas, hasta max_rows.
        const excluir = new Set((params[4] ?? []) as string[]);
        return tabla.filter((foto) => !excluir.has(foto.foto_id)).slice(0, Number(params[3]));
      }
      return lotes.shift() ?? [];
    }
    if (sql.includes('retencion_purgar_fotos')) {
      const ids = (params[3] ?? []) as string[];
      if (tabla) {
        for (const id of ids) {
          const indice = tabla.findIndex((foto) => foto.foto_id === id);
          if (indice >= 0) tabla.splice(indice, 1);
        }
      }
      return [{ filas_borradas: ids.length, bytes_liberados: String(ids.length * 1000) }];
    }
    return [];
  });

  // El runner que abre `reglasDe` para leer la configuracion de cada empresa.
  const runnerQuery: jest.Mock = jest.fn(async () => []);
  const runner = {
    connect: jest.fn(async () => undefined),
    startTransaction: jest.fn(async () => undefined),
    commitTransaction: jest.fn(async () => undefined),
    rollbackTransaction: jest.fn(async () => undefined),
    release: jest.fn(async () => undefined),
    manager: { query: runnerQuery },
  } as unknown as QueryRunner;

  const dataSource = {
    query,
    createQueryRunner: () => runner,
  } as unknown as DataSource;

  const reglas: PatrolRules = { ...DEFAULT_PATROL_RULES, ...opciones.reglas };
  let tenantEnCurso = '';
  const effective = jest.fn(async () => {
    if (reglasQueFallan.has(tenantEnCurso)) throw new Error('reglas ilegibles');
    return reglas;
  });
  // El servicio setea el tenant con set_config antes de pedir las reglas: se
  // aprovecha esa llamada para saber de que empresa se estan leyendo.
  runnerQuery.mockImplementation(async (_sql: string, params: unknown[] = []) => {
    tenantEnCurso = String(params[0] ?? '');
    return [];
  });

  const agenda = { upsertJobScheduler: jest.fn(async () => undefined) } as unknown as Queue;
  const contexto = new TenantContextService();

  return {
    query,
    runner,
    agenda,
    contexto,
    effective,
    marcados,
    crear: (evidencePath: string) =>
      new PurgaRetencionService(
        agenda,
        dataSource,
        contexto,
        { effective } as unknown as RulesService,
        { getOrThrow: () => evidencePath } as unknown as ConfigService,
      ),
  };
}

function llamadas(query: jest.Mock, fragmento: string): unknown[][] {
  return query.mock.calls.filter(([sql]) => String(sql).includes(fragmento));
}

describe('purga por retencion', () => {
  let base: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'sentrycore-purga-svc-'));
  });

  async function crearArchivo(rutaRelativa: string): Promise<void> {
    await mkdir(join(base, rutaRelativa, '..'), { recursive: true });
    await writeFile(join(base, rutaRelativa), 'x');
  }

  it('no borra nada cuando no hay nada vencido', async () => {
    const entorno = crearEntorno({ lotesDeFotos: [[]], trazasPorLote: [0] });

    const resultado = await entorno.crear(base).purgar();

    expect(resultado).toEqual({
      tenants: 1,
      trazas: 0,
      fotos: 0,
      conservadas: 0,
      fallidas: 0,
    });
    expect(llamadas(entorno.query, 'retencion_purgar_fotos')).toHaveLength(0);
  });

  it('usa los dias de la REGLA del tenant y no un numero fijo', async () => {
    const entorno = crearEntorno({
      reglas: { photoRetentionDays: 45, gpsTrackRetentionDays: 15 },
      lotesDeFotos: [[]],
      trazasPorLote: [0],
    });

    await entorno.crear(base).purgar();

    // [tenantId, dias, lote]
    expect(llamadas(entorno.query, 'retencion_purgar_trazas')[0]?.[1]).toEqual([
      EMPRESA_A,
      15,
      expect.any(Number),
    ]);
    // [tenantId, conjunto, dias, lote, excluir]
    expect(llamadas(entorno.query, 'retencion_fotos_vencidas')[0]?.[1]).toEqual([
      EMPRESA_A,
      'scan_photos',
      45,
      expect.any(Number),
      [],
    ]);
  });

  it('borra el archivo ANTES que la fila, y solo manda a borrar lo que ya no esta', async () => {
    await crearArchivo(join('empresa', 'ronda', 'una.jpg'));
    await crearArchivo(join('empresa', 'ronda', 'otra.jpg'));

    const entorno = crearEntorno({
      lotesDeFotos: [
        [
          { foto_id: 'f1', ruta_relativa: join('empresa', 'ronda', 'una.jpg'), peso_bytes: '10' },
          { foto_id: 'f2', ruta_relativa: join('empresa', 'ronda', 'otra.jpg'), peso_bytes: '20' },
        ],
      ],
      trazasPorLote: [0],
    });

    const resultado = await entorno.crear(base).purgar();

    expect(resultado.fotos).toBe(2);
    expect(existsSync(join(base, 'empresa', 'ronda', 'una.jpg'))).toBe(false);
    expect(existsSync(join(base, 'empresa', 'ronda', 'otra.jpg'))).toBe(false);
    expect(llamadas(entorno.query, 'retencion_purgar_fotos')[0]?.[1]).toEqual([
      EMPRESA_A,
      'scan_photos',
      DEFAULT_PATROL_RULES.photoRetentionDays,
      ['f1', 'f2'],
    ]);
  });

  it('conserva la fila de la foto cuyo archivo no se pudo borrar', async () => {
    await crearArchivo(join('empresa', 'ronda', 'buena.jpg'));
    // Un directorio en lugar del archivo hace fallar el unlink en cualquier SO.
    await mkdir(join(base, 'empresa', 'ronda', 'trabada.jpg'), { recursive: true });

    const entorno = crearEntorno({
      lotesDeFotos: [
        [
          {
            foto_id: 'trabada',
            ruta_relativa: join('empresa', 'ronda', 'trabada.jpg'),
            peso_bytes: '10',
          },
          {
            foto_id: 'buena',
            ruta_relativa: join('empresa', 'ronda', 'buena.jpg'),
            peso_bytes: '10',
          },
        ],
      ],
      trazasPorLote: [0],
    });

    const resultado = await entorno.crear(base).purgar();

    expect(resultado.conservadas).toBe(1);
    // La invariante del carril: nunca una fila sin archivo. La trabada sigue en
    // disco, asi que su fila NO viaja al DELETE.
    expect(llamadas(entorno.query, 'retencion_purgar_fotos')[0]?.[1]).toEqual([
      EMPRESA_A,
      'scan_photos',
      DEFAULT_PATROL_RULES.photoRetentionDays,
      ['buena'],
    ]);
    expect(existsSync(join(base, 'empresa', 'ronda', 'trabada.jpg'))).toBe(true);
  });

  it('sigue pidiendo lotes mientras el lote venga completo', async () => {
    // Las fotos de este lote NO se crean en disco, y es a proposito: "el archivo
    // ya no estaba" es un caso sano y documentado (purga anterior a medias) que
    // deja la fila borrable igual. Lo que se prueba aca es el recorrido por
    // lotes, no el borrado; que el archivo desaparezca de verdad lo prueban
    // evidencia-en-disco.spec.ts y el test de "archivo ANTES que la fila", con
    // dos archivos reales en vez de doscientos.
    const loteLleno: FotoFalsa[] = [];
    for (let i = 0; i < PURGA_LOTE_FOTOS; i += 1) {
      loteLleno.push({
        foto_id: `f${i}`,
        ruta_relativa: join('empresa', 'ronda', `f${i}.jpg`),
        peso_bytes: '10',
      });
    }

    const entorno = crearEntorno({ lotesDeFotos: [loteLleno, []], trazasPorLote: [0] });

    const resultado = await entorno.crear(base).purgar();

    expect(resultado.fotos).toBe(PURGA_LOTE_FOTOS);
    expect(llamadas(entorno.query, 'retencion_fotos_vencidas')).toHaveLength(2);
  });

  /**
   * BUG 2 DEL ISSUE. Vale la pena escribirlo entero porque el numero equivocado
   * no se ve raro: crece, y crecer es lo que uno espera de un contador.
   *
   * El escenario es el minimo que lo reproduce: un lote LLENO (asi el barrido
   * pide otro) del que un archivo esta trabado. Antes, ese unico archivo se
   * contaba una vez por lote y ademas volvia a encabezar cada lote.
   */
  describe('archivos trabados a lo largo de la pasada', () => {
    async function entornoConUnaTrabada(cuantasSanas: number) {
      const tabla: FotoFalsa[] = [];
      // La trabada es la MAS VIEJA: la funcion devuelve por created_at, asi que
      // en la tabla va primera y sale primera en todos los lotes. Un directorio
      // donde deberia ir el archivo hace fallar el unlink en cualquier SO.
      await mkdir(join(base, 'empresa', 'ronda', 'trabada.jpg'), { recursive: true });
      tabla.push({
        foto_id: 'trabada',
        ruta_relativa: join('empresa', 'ronda', 'trabada.jpg'),
        peso_bytes: '10',
      });
      // Las sanas no se crean en disco: "el archivo ya no estaba" es un caso
      // sano y las deja borrables igual. Estos tres tests miden el recorrido por
      // lotes con cientos de filas, y crear cientos de archivos de verdad solo
      // agregaria tiempo de disco —suficiente para que la suite completa se pase
      // del timeout de jest en una maquina cargada— sin probar nada mas.
      for (let i = 0; i < cuantasSanas; i += 1) {
        tabla.push({
          foto_id: `s${i}`,
          ruta_relativa: join('empresa', 'ronda', `s${i}.jpg`),
          peso_bytes: '10',
        });
      }
      return crearEntorno({ tablaDeFotos: tabla, trazasPorLote: [0] });
    }

    it('cuenta UNA vez el mismo archivo trabado, aunque la pasada tenga varios lotes', async () => {
      // 3 lotes de trabajo: sin el arreglo, conservadas daba 3.
      const entorno = await entornoConUnaTrabada(PURGA_LOTE_FOTOS * 2 + 5);

      const resultado = await entorno.crear(base).purgar();

      expect(llamadas(entorno.query, 'retencion_fotos_vencidas').length).toBeGreaterThan(1);
      expect(resultado.conservadas).toBe(1);
    });

    it('la excluye del lote siguiente en vez de volver a tropezarse con ella', async () => {
      const entorno = await entornoConUnaTrabada(PURGA_LOTE_FOTOS * 2 + 5);

      await entorno.crear(base).purgar();

      const pedidos = llamadas(entorno.query, 'retencion_fotos_vencidas');
      // El primero no excluye nada; del segundo en adelante, la trabada ya no se
      // vuelve a pedir.
      expect((pedidos[0]?.[1] as unknown[])[4]).toEqual([]);
      for (const pedido of pedidos.slice(1)) {
        expect((pedido[1] as unknown[])[4]).toEqual(['trabada']);
      }
    });

    it('un archivo trabado no tapa a la evidencia vencida que viene detras', async () => {
      // Lo mas grave de los dos sintomas: con el lote lleno de trabados, el
      // barrido cortaba y la empresa entera se quedaba sin purgar por un archivo
      // con los permisos mal puestos.
      const sanas = PURGA_LOTE_FOTOS * 2;
      const entorno = await entornoConUnaTrabada(sanas);

      const resultado = await entorno.crear(base).purgar();

      expect(resultado.fotos).toBe(sanas);
      expect(resultado.conservadas).toBe(1);
    });

    it('corta la pasada de esa empresa cuando no se puede borrar ni un archivo', async () => {
      // Ni un archivo se puede borrar: no hay que insistir hasta el tope de la
      // pasada, la proxima lo reintenta. Se usan rutas fuera del volumen porque
      // se conservan igual que un unlink fallido y no cuestan un mkdir cada una.
      const tabla: FotoFalsa[] = [];
      for (let i = 0; i < PURGA_MAX_TRABADAS_POR_TENANT + PURGA_LOTE_FOTOS; i += 1) {
        tabla.push({
          foto_id: `t${i}`,
          ruta_relativa: join('..', 'fuera', `t${i}.jpg`),
          peso_bytes: '10',
        });
      }
      const entorno = crearEntorno({ tablaDeFotos: tabla, trazasPorLote: [0] });

      const resultado = await entorno.crear(base).purgar();

      expect(resultado.fotos).toBe(0);
      expect(llamadas(entorno.query, 'retencion_purgar_fotos')).toHaveLength(0);
      const pedidos = llamadas(entorno.query, 'retencion_fotos_vencidas').length;
      expect(pedidos).toBeLessThan(PURGA_MAX_FOTOS_POR_TENANT / PURGA_LOTE_FOTOS);
    });
  });

  /**
   * BUG 1 DEL ISSUE. El sintoma no era un error sino una empresa que no aparece
   * nunca, asi que lo que se prueba es que la marca se escribe — que es lo unico
   * que hace avanzar la rotacion de `retencion_tenants`.
   */
  describe('rotacion de empresas', () => {
    it('marca como barrida a cada empresa que atendio', async () => {
      const entorno = crearEntorno({
        tenants: [EMPRESA_A, EMPRESA_B],
        lotesDeFotos: [[], []],
        trazasPorLote: [0, 0],
      });

      await entorno.crear(base).purgar();

      expect(entorno.marcados).toEqual([EMPRESA_A, EMPRESA_B]);
    });

    it('marca tambien a la empresa que fallo, para que no tape a las de atras', async () => {
      // Sin esto, una sola empresa rota se queda en la cabeza del orden pasada
      // tras pasada y las que vienen detras dejan de purgarse: el mismo bug con
      // otro disfraz.
      const entorno = crearEntorno({
        tenants: [EMPRESA_A, EMPRESA_B],
        reglasQueFallan: [EMPRESA_A],
        lotesDeFotos: [[]],
        trazasPorLote: [0],
      });

      const resultado = await entorno.crear(base).purgar();

      expect(resultado.fallidas).toBe(1);
      expect(entorno.marcados).toEqual([EMPRESA_A, EMPRESA_B]);
    });

    it('una marca que falla no cuenta como empresa fallida ni corta el barrido', async () => {
      // No se dejo de borrar nada: lo unico que pasa es que esa empresa repite
      // turno. Contarlo como fallo seria una alarma por algo que no perdio dato.
      const entorno = crearEntorno({
        tenants: [EMPRESA_A, EMPRESA_B],
        marcasQueFallan: [EMPRESA_A],
        lotesDeFotos: [[], []],
        trazasPorLote: [0, 0],
      });

      const resultado = await entorno.crear(base).purgar();

      expect(resultado.fallidas).toBe(0);
      expect(entorno.marcados).toEqual([EMPRESA_B]);
    });
  });

  it('NO purga las fotos del libro de novedades mientras no exista su regla', async () => {
    await crearArchivo(join('empresa', 'ronda', 'una.jpg'));
    const entorno = crearEntorno({
      lotesDeFotos: [
        [{ foto_id: 'f1', ruta_relativa: join('empresa', 'ronda', 'una.jpg'), peso_bytes: '10' }],
        [],
      ],
      trazasPorLote: [0],
    });

    await entorno.crear(base).purgar();

    const conjuntos = llamadas(entorno.query, 'retencion_fotos_vencidas').map(
      ([, params]) => (params as unknown[])[1],
    );
    expect(conjuntos).not.toContain('event_photos');
  });

  it('purga las novedades el dia que la regla exista', async () => {
    await crearArchivo(join('empresa', 'novedades', 'ev', 'una.jpg'));
    const entorno = crearEntorno({
      // La regla todavia no esta en el catalogo: se simula un tenant que ya la
      // tiene configurada, que es exactamente el caso del dia despues del merge.
      reglas: { incidentPhotoRetentionDays: 180 } as unknown as Partial<PatrolRules>,
      lotesDeFotos: [
        [],
        [
          {
            foto_id: 'n1',
            ruta_relativa: join('empresa', 'novedades', 'ev', 'una.jpg'),
            peso_bytes: '10',
          },
        ],
      ],
      trazasPorLote: [0],
    });

    const resultado = await entorno.crear(base).purgar();

    expect(resultado.fotos).toBe(1);
    expect(llamadas(entorno.query, 'retencion_purgar_fotos')[0]?.[1]).toEqual([
      EMPRESA_A,
      'event_photos',
      180,
      ['n1'],
    ]);
  });

  it('pide lotes de traza hasta que uno venga incompleto', async () => {
    const entorno = crearEntorno({
      lotesDeFotos: [[]],
      trazasPorLote: [5_000, 5_000, 120],
    });

    const resultado = await entorno.crear(base).purgar();

    expect(resultado.trazas).toBe(10_120);
    expect(llamadas(entorno.query, 'retencion_purgar_trazas')).toHaveLength(3);
  });

  it('una empresa que falla no corta el barrido de las demas', async () => {
    const entorno = crearEntorno({
      tenants: [EMPRESA_A, EMPRESA_B],
      reglasQueFallan: [EMPRESA_A],
      lotesDeFotos: [[]],
      trazasPorLote: [0, 7],
    });

    const resultado = await entorno.crear(base).purgar();

    expect(resultado.fallidas).toBe(1);
    expect(resultado.tenants).toBe(2);
    // La empresa B se barrio igual: su plazo legal corre aunque la A este rota.
    expect(llamadas(entorno.query, 'retencion_purgar_trazas')[0]?.[1]).toEqual([
      EMPRESA_B,
      expect.any(Number),
      expect.any(Number),
    ]);
  });

  it('lee las reglas de cada empresa con SET LOCAL y sin usuario', async () => {
    const entorno = crearEntorno({ lotesDeFotos: [[]], trazasPorLote: [0] });

    await entorno.crear(base).purgar();

    const setConfig = (entorno.runner.manager.query as unknown as jest.Mock).mock.calls[0];
    // El tercer parametro en true es SET LOCAL: sin el, el tenant queda pegado a
    // la conexion del pool y el siguiente job hereda la empresa anterior.
    expect(String(setConfig?.[0])).toContain("set_config('app.tenant_id', $1, true)");
    expect(String(setConfig?.[0])).toContain("set_config('app.user_id', '', true)");
    expect(setConfig?.[1]).toEqual([EMPRESA_A]);
  });

  it('programa el barrido sin esperar a Redis y no revienta el arranque', () => {
    const entorno = crearEntorno();
    (entorno.agenda.upsertJobScheduler as unknown as jest.Mock).mockRejectedValueOnce(
      new Error('redis caido'),
    );

    // Una API que no arranca es un guardia que no puede escanear.
    expect(() => entorno.crear(base).onModuleInit()).not.toThrow();
  });

  describe('resumen para el ADMIN', () => {
    it('devuelve la politica vigente y las ultimas corridas', async () => {
      const entorno = crearEntorno({ reglas: { photoRetentionDays: 90 } });
      const servicio = entorno.crear(base);
      const runner = {
        manager: {
          query: async () => [
            {
              id: 'corrida-1',
              dataset: 'scan_photos',
              retention_days: 90,
              cutoff: new Date('2026-05-01T00:00:00Z'),
              rows_deleted: 12,
              bytes_freed: '2048',
              executed_at: new Date('2026-08-01T00:00:00Z'),
            },
          ],
        },
      } as unknown as QueryRunner;

      const resumen = await entorno.contexto.run(runner, () => servicio.resumenDelTenant());

      expect(resumen.politica.scan_photos).toBe(90);
      // 0 = no se purga. Es la respuesta correcta hoy y tiene que verse.
      expect(resumen.politica.event_photos).toBe(0);
      expect(resumen.corridas[0]).toMatchObject({
        conjunto: 'scan_photos',
        filasBorradas: 12,
        // bigint llega como string del driver: si esto sale como '2048' el panel
        // suma texto.
        bytesLiberados: 2048,
      });
    });
  });

  describe('retencionFotosDeNovedades', () => {
    it('sin la regla en el catalogo devuelve 0 = no purgar nunca', () => {
      expect(retencionFotosDeNovedades(DEFAULT_PATROL_RULES)).toBe(0);
    });

    it('descarta un valor fuera del rango del piso', () => {
      const reglas = { ...DEFAULT_PATROL_RULES, incidentPhotoRetentionDays: 5 };
      expect(retencionFotosDeNovedades(reglas as unknown as PatrolRules)).toBe(0);
    });

    it('acepta un valor valido', () => {
      const reglas = { ...DEFAULT_PATROL_RULES, incidentPhotoRetentionDays: 180 };
      expect(retencionFotosDeNovedades(reglas as unknown as PatrolRules)).toBe(180);
    });
  });
});
