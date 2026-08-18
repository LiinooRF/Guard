import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { patrolRulesSchema } from '@sentrycore/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { BrandingService } from '../branding/branding.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';
import { FILTRO_RECINTOS } from '../stats/stats-site-scope';
import type { SupervisorService } from '../supervisor/supervisor.service';
import { horaLocalIso } from './excel-export.model';
import { ExcelExportService } from './excel-export.service';

/**
 * Lo que se prueba aca es el SQL y los permisos.
 *
 * Las aserciones sobre la consulta son literales a proposito: dos bugs de esta
 * semana fueron una columna que no existia y un parentesis de mas, y los dos
 * pasaron el CI porque el mock devolvia lo que el autor esperaba. Un mock no
 * puede validar SQL; lo unico que puede hacer es dejar el texto de la consulta
 * a la vista para que se compare contra la migracion.
 */

const REGLAS = { ...patrolRulesSchema.parse({}), excelExportMaxRows: 2 };

const reglasMock = () =>
  ({ effective: jest.fn().mockResolvedValue(REGLAS) }) as unknown as RulesService;

const marcaMock = () =>
  ({
    forDocuments: jest.fn().mockResolvedValue({
      displayName: 'Seguridad Demo SpA',
      logoUri: null,
      primaryColor: '#1f3b73',
      mailFromName: 'Seguridad Demo SpA',
      mailFooter: null,
    }),
  }) as unknown as BrandingService;

const supervisorMock = (asignado = true) =>
  ({
    ensureAssignedSite: jest.fn().mockImplementation(async () => {
      if (!asignado) throw new ForbiddenException('No tienes este recinto asignado');
    }),
  }) as unknown as SupervisorService;

const RONDA = {
  id: 'p1',
  fecha_local: '2026-07-06',
  inicio_programado_local: '2026-07-06T22:00:00',
  fin_programado_local: '2026-07-07T06:00:00',
  inicio_real_local: null,
  cierre_local: null,
  site_name: 'Planta Norte',
  branch_name: 'Casa matriz',
  timezone: 'America/Santiago',
  route_name: 'Ronda nocturna',
  guard_name: 'Juan Soto',
  status: 'completada',
  compliance_pct: '90.00',
  is_voluntary: false,
  puntos_esperados: 12,
  puntos_marcados: '11',
  novedades: '0',
};

const armar = (
  manager: { query: jest.Mock },
  supervisor: SupervisorService = supervisorMock(),
) =>
  new ExcelExportService(
    { manager } as unknown as TenantContextService,
    reglasMock(),
    marcaMock(),
    supervisor,
  );

const ADMIN = { userId: 'u-admin', role: 'ADMIN' as const };
const SUPERVISOR = { userId: 'u-sup', role: 'SUPERVISOR' as const };

/**
 * Las tres consultas son SELECT, y para un SELECT el driver de postgres
 * devuelve UN arreglo de filas. (Un UPDATE o un DELETE por `manager.query()`
 * devolveria `[filas, rowCount]`; aca no hay ninguno, y si alguna vez lo
 * hubiera este mock tendria que cambiar de forma.)
 */
const sinDatos = () => {
  const manager = { query: jest.fn() };
  manager.query.mockResolvedValue([]);
  return manager;
};

/** Devuelve las tres hojas de datos en orden: rondas, escaneos, novedades. */
const conFilas = (
  rondas: unknown[] = [],
  escaneos: unknown[] = [],
  novedades: unknown[] = [],
) => {
  const manager = { query: jest.fn() };
  manager.query
    .mockResolvedValueOnce(rondas)
    .mockResolvedValueOnce(escaneos)
    .mockResolvedValueOnce(novedades);
  return manager;
};

describe('ExcelExportService.construir', () => {
  it('consulta rondas, escaneos y novedades con los mismos filtros', async () => {
    const manager = sinDatos();
    await armar(manager).construir({ from: '2026-07-01', to: '2026-07-31' }, ADMIN);

    expect(manager.query).toHaveBeenCalledTimes(3);
    for (const llamada of manager.query.mock.calls) {
      const [sql, parametros] = llamada as [string, unknown[]];
      expect(parametros).toEqual([
        '2026-07-01',
        '2026-07-31',
        null, // supervisor: el ADMIN no se filtra por recintos asignados
        null,
        null,
        null,
        3, // tope (2) + 1: la fila extra delata la exportacion cortada
      ]);
      expect(sql).toContain('LIMIT $7::int');
    }
  });

  it('suma el dia al timestamp SIN zona antes de convertir', async () => {
    const manager = sinDatos();
    await armar(manager).construir({}, ADMIN);

    for (const [sql] of manager.query.mock.calls as Array<[string]>) {
      // Correcto: (fecha + 1 dia) AT TIME ZONE. Al reves, el dia del cambio de
      // horario dura 23 o 25 horas y el ultimo dia del rango queda corrido.
      expect(sql).toContain("(($2::date::timestamp + INTERVAL '1 day') AT TIME ZONE s.timezone)");
      expect(sql).not.toMatch(/AT TIME ZONE s\.timezone\)\s*\+\s*INTERVAL/);
      expect(sql).toContain('($1::date::timestamp AT TIME ZONE s.timezone)');
      expect(sql).not.toContain("AT TIME ZONE 'UTC'");
    }
  });

  it('resuelve las horas en la zona del recinto y en texto sin zona', async () => {
    const manager = sinDatos();
    await armar(manager).construir({}, ADMIN);
    const [sqlRondas, sqlEscaneos, sqlNovedades] = manager.query.mock.calls.map(
      (llamada) => (llamada as [string])[0],
    );

    expect(sqlRondas).toContain(
      `to_char(p.scheduled_start_at AT TIME ZONE s.timezone, 'YYYY-MM-DD"T"HH24:MI:SS')`,
    );
    expect(sqlEscaneos).toContain('sc.scanned_at_server AT TIME ZONE s.timezone');
    expect(sqlNovedades).toContain('fe.reported_at_server AT TIME ZONE s.timezone');
  });

  it('usa las columnas que existen en las migraciones', async () => {
    const manager = sinDatos();
    await armar(manager).construir({}, ADMIN);
    const [rondas, escaneos, novedades] = manager.query.mock.calls.map(
      (llamada) => (llamada as [string])[0],
    );

    // patrols / sites / routes / users: 1722350000000 y 1722524400000.
    expect(rondas).toContain('p.compliance_pct');
    expect(rondas).toContain('p.is_voluntary');
    expect(rondas).toContain('jsonb_array_length(p.expected_checkpoint_ids)');
    expect(rondas).toContain("(u.given_name || ' ' || u.family_name) AS guard_name");
    // `tenants.name` no existe: el nombre de la empresa lo entrega
    // BrandingService, que ya resuelve display_name / legal_name.
    expect(rondas).not.toContain('FROM tenants');

    // scans: 1723734000000 y clock_offset_ms de 1725462020000.
    expect(escaneos).toContain('sc.scanned_at_device');
    expect(escaneos).toContain('sc.anomalies');
    expect(escaneos).toContain('sc.clock_offset_ms');
    expect(escaneos).toContain('ph.scan_id = sc.id');

    // field_events: 1723820400000. event_photos referencia por event_id.
    expect(novedades).toContain('fe.criticality');
    expect(novedades).toContain('fe.corrects_event_id');
    expect(novedades).toContain('ep.event_id = fe.id');
  });

  it('deja los parentesis balanceados en las tres consultas', async () => {
    const manager = sinDatos();
    await armar(manager).construir({}, ADMIN);
    for (const [sql] of manager.query.mock.calls as Array<[string]>) {
      let abiertos = 0;
      for (const caracter of sql) {
        if (caracter === '(') abiertos += 1;
        if (caracter === ')') abiertos -= 1;
        expect(abiertos).toBeGreaterThanOrEqual(0);
      }
      expect(abiertos).toBe(0);
    }
  });

  it('al SUPERVISOR lo encierra en sus recintos asignados', async () => {
    const manager = sinDatos();
    await armar(manager).construir({}, SUPERVISOR);

    for (const llamada of manager.query.mock.calls) {
      const [sql, parametros] = llamada as [string, unknown[]];
      expect(parametros[2]).toBe('u-sup');
      expect(sql).toContain('FROM supervisor_sites ss');
    }
  });

  it('usa el filtro de recintos COMPARTIDO, no una copia propia', async () => {
    // El filtro es un control de acceso. Si esta escrito dos veces, el dia que
    // se corrija en un lado la exportacion se queda con la version vieja y
    // nadie se entera. Por eso se compara contra la constante importada y no
    // contra un texto repetido aca.
    const manager = sinDatos();
    await armar(manager).construir({}, SUPERVISOR);
    for (const [sql] of manager.query.mock.calls as Array<[string]>) {
      expect(sql).toContain(FILTRO_RECINTOS);
    }
  });

  it('responde 403 —y no una planilla vacia— si el recinto no es suyo', async () => {
    const manager = sinDatos();
    const service = armar(manager, supervisorMock(false));
    await expect(
      service.construir({ siteId: '5b1a0a1e-0000-4000-8000-000000000001' }, SUPERVISOR),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('responde 404 si el recinto pedido no existe', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    await expect(
      armar(manager).construir({ siteId: '5b1a0a1e-0000-4000-8000-000000000001' }, ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rechaza un rango mas largo que el tope de la tabla de escaneos', async () => {
    const manager = sinDatos();
    await expect(
      armar(manager).construir({ from: '2025-01-01', to: '2026-01-01' }, ADMIN),
    ).rejects.toThrow(/maximo/i);
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('corta en el tope y lo anuncia en la portada', async () => {
    const manager = conFilas([RONDA, RONDA, RONDA]); // una mas que el tope (2)

    const libro = await armar(manager).construir({}, ADMIN);

    expect(libro.conteos.rondas).toBe(2);
    expect(JSON.stringify(libro.hojas[0]!.filas)).toContain('ATENCIÓN');
  });

  // -------------------------------------------------------- zona de la portada

  it('con una sola zona la portada la nombra y ahi resuelve «Generado el»', async () => {
    const manager = conFilas([RONDA]);
    const libro = await armar(manager).construir({}, ADMIN);
    const portada = libro.hojas[0]!;

    expect(portada.filas[4]![1]).toEqual({ tipo: 'texto', valor: 'America/Santiago' });
    expect(portada.filas[5]![1]).toEqual({
      tipo: 'fechaHora',
      valor: horaLocalIso(libro.generadoEn, 'America/Santiago'),
    });
  });

  it('con recintos en zonas distintas no elige una al azar para la portada', async () => {
    // America/Santiago y Pacific/Easter en el mismo tenant es lo normal en
    // Chile, y `sites.timezone` es POR RECINTO. Antes, «Generado el» salia en
    // la zona de la primera fila que devolviera la base: dos horas corridas
    // segun el ORDER BY.
    const manager = conFilas([RONDA, { ...RONDA, id: 'p2', timezone: 'Pacific/Easter' }]);
    const libro = await armar(manager).construir({}, ADMIN);
    const portada = libro.hojas[0]!;
    const referencia = (portada.filas[4]![1] as { valor: string }).valor;

    expect(referencia).toContain('varias');
    expect(referencia).toContain('America/Santiago');
    expect(referencia).toContain('Pacific/Easter');
    // La hora de generacion queda en una zona EXPLICITA y rotulada.
    expect(referencia).toContain('UTC');
    expect(portada.filas[5]![1]).toEqual({
      tipo: 'fechaHora',
      valor: horaLocalIso(libro.generadoEn, 'UTC'),
    });
  });

  it('con recinto pedido manda la zona de ese recinto, no la de los datos', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([{ name: 'Planta Norte', timezone: 'Pacific/Easter' }])
      .mockResolvedValueOnce([RONDA]) // los datos dicen America/Santiago
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const libro = await armar(manager).construir(
      { siteId: '5b1a0a1e-0000-4000-8000-000000000001' },
      ADMIN,
    );

    expect(libro.hojas[0]!.filas[4]![1]).toEqual({
      tipo: 'texto',
      valor: 'Pacific/Easter',
    });
  });

  it('nombra el archivo con el periodo exportado', async () => {
    const manager = sinDatos();
    const libro = await armar(manager).construir({ from: '2026-07-01', to: '2026-07-31' }, ADMIN);
    expect(libro.filename).toBe('exportacion-rondas-20260701-20260731.xlsx');
  });

  it('estampa el color de marca del tenant en el encabezado', async () => {
    const manager = sinDatos();
    const libro = await armar(manager).construir({}, ADMIN);
    expect(libro.colorEncabezado).toBe('#1f3b73');
    // El texto lo decide el contraste, no una preferencia: un amarillo de marca
    // con letras blancas encima no se lee.
    expect(libro.colorTextoEncabezado).toBe('#ffffff');
  });

  it('escribe un xlsx que empieza con la firma de un ZIP', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([RONDA])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const service = armar(manager);
    const libro = await service.construir({}, ADMIN);

    const trozos: Buffer[] = [];
    const destino = {
      write(datos: Buffer) {
        trozos.push(Buffer.from(datos));
        return true;
      },
    } as unknown as NodeJS.WritableStream;
    await service.escribir(libro, destino);

    const bytes = Buffer.concat(trozos);
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(bytes.length).toBeGreaterThan(1000);
  });
});

/**
 * El filtro de recintos del SUPERVISOR nacio duplicado: la misma constante,
 * byte por byte, en `stats-charts.service.ts` y aca. Se movio a
 * `stats/stats-site-scope.ts` y este test es lo que impide que vuelva.
 *
 * Lee el archivo de las graficas a proposito: un import compartido que solo se
 * usa de un lado no arregla nada, y una copia nueva no la detecta ningun
 * typecheck.
 */
describe('el filtro de recintos existe una sola vez en el repo', () => {
  const FUENTES: Array<[string, string]> = [
    ['stats-charts.service.ts', join(__dirname, '..', 'stats', 'stats-charts.service.ts')],
    ['excel-export.service.ts', join(__dirname, 'excel-export.service.ts')],
  ];

  it.each(FUENTES)('%s importa el fragmento y no declara el suyo', (_nombre, ruta) => {
    const fuente = readFileSync(ruta, 'utf8');
    // Si esto falla en stats-charts.service.ts, falta aplicar el parche del
    // punto 5 de INTEGRACION.md: borrar su `const FILTRO_RECINTOS` e importarlo
    // de `./stats-site-scope`.
    expect(fuente).not.toMatch(/const\s+FILTRO_RECINTOS\s*=/);
    expect(fuente).toMatch(/import\s*\{[^}]*FILTRO_RECINTOS[^}]*\}\s*from\s*'[^']*stats-site-scope'/);
  });
});
