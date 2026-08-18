import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { patrolRulesSchema, type PatrolRules } from '@sentrycore/shared';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { EventsStreamService } from '../events-stream/events-stream.service';
import type { MailQueueService } from '../mail/mail-queue.service';
import type { RulesService } from '../rules/rules.service';
import { ChecklistsService, type ChecklistItemView } from './checklists.service';

/**
 * `checklistFailureNotify` se agrega a patrolRulesSchema (ver INTEGRACION.md).
 * Se mezcla aca para que el test describa el contrato que el servicio consume.
 */
function reglas(notificar: boolean): PatrolRules {
  return {
    ...patrolRulesSchema.parse({}),
    checklistFailureNotify: notificar,
  } as unknown as PatrolRules;
}

const RONDA = {
  id: 'patrol-1',
  tenant_id: 't-1',
  site_id: 'site-1',
  shift_id: 'shift-1',
};

const ITEM_SIMPLE: ChecklistItemView = {
  id: 'item-1',
  position: 1,
  label: 'Extintor de la bodega',
  responseType: 'ok_falla',
  requiresPhotoOnFail: false,
  checkpointId: null,
  dueLocalTime: null,
  requiresPhoto: false,
};

const ITEM_CON_FOTO: ChecklistItemView = {
  id: 'item-2',
  position: 2,
  label: 'Puerta de acceso norte',
  responseType: 'ok_falla',
  requiresPhotoOnFail: true,
  checkpointId: null,
  dueLocalTime: null,
  requiresPhoto: false,
};

const ITEM_CON_FOTO_SIEMPRE: ChecklistItemView = {
  id: 'item-foto-siempre',
  position: 3,
  label: 'Fotografiar el estado del acceso',
  responseType: 'ok_falla',
  requiresPhotoOnFail: false,
  checkpointId: null,
  dueLocalTime: null,
  requiresPhoto: true,
};

/** La tarea del requisito: a las 11, en ESE punto, y con foto del refrigerador. */
const TAREA_DEL_PUNTO: ChecklistItemView = {
  id: 'item-3',
  position: 3,
  label: 'Fotografiar el refrigerador',
  responseType: 'ok_falla',
  requiresPhotoOnFail: false,
  checkpointId: 'punto-cocina',
  dueLocalTime: '11:00:00',
  requiresPhoto: true,
};

const PLANTILLA = {
  id: 'tpl-1',
  name: 'Ronda nocturna',
  site_id: 'site-1',
  shift_id: 'shift-1',
  is_active: true,
  items: [ITEM_SIMPLE, ITEM_CON_FOTO],
};

function servicio(
  query: jest.Mock,
  opciones: { notificar?: boolean; enqueue?: jest.Mock } = {},
) {
  // La forma REAL de lo que devuelve MailQueueService.enqueue: union
  // discriminada con `estado`. Un mock que solo devuelva `{ jobId }` haria
  // pasar un test que en produccion no cuenta ningun envio.
  const enqueue =
    opciones.enqueue ?? jest.fn().mockResolvedValue({ estado: 'encolado', jobId: 'mail-job' });
  const publish = jest.fn();
  const service = new ChecklistsService(
    { manager: { query } } as unknown as TenantContextService,
    { enqueue } as unknown as MailQueueService,
    {
      effective: jest.fn().mockResolvedValue(reglas(opciones.notificar ?? true)),
    } as unknown as RulesService,
    { publish } as unknown as EventsStreamService,
  );
  return { service, enqueue, publish };
}

describe('ChecklistsService — plantilla vigente (#129)', () => {
  it('resuelve por recinto y turno de la ronda, con la mas especifica primero', async () => {
    const query = jest.fn().mockResolvedValueOnce([RONDA]).mockResolvedValueOnce([PLANTILLA]);
    const { service } = servicio(query);

    await expect(service.templateForPatrol('patrol-1', 'guard-1')).resolves.toEqual({
      patrolId: 'patrol-1',
      hasChecklist: true,
      template: { id: 'tpl-1', name: 'Ronda nocturna', items: [ITEM_SIMPLE, ITEM_CON_FOTO] },
    });

    const [sql, parametros] = query.mock.calls[1] as [string, unknown[]];
    expect(parametros).toEqual(['site-1', 'shift-1']);
    expect(sql).toContain('(t.site_id IS NOT NULL)::int + (t.shift_id IS NOT NULL)::int DESC');
  });

  it('una ronda sin checklist configurado responde que no hay, no un error', async () => {
    const query = jest.fn().mockResolvedValueOnce([RONDA]).mockResolvedValueOnce([]);
    const { service } = servicio(query);

    await expect(service.templateForPatrol('patrol-1', 'guard-1')).resolves.toEqual({
      patrolId: 'patrol-1',
      hasChecklist: false,
    });
  });

  it('una ronda que no es del guardia es 404', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    const { service } = servicio(query);

    await expect(service.templateForPatrol('patrol-1', 'otro-guardia')).rejects.toThrow(
      NotFoundException,
    );
  });
});

describe('ChecklistsService — respuestas y aviso de falla (#129)', () => {
  it('la falla la decide el servidor: "falla" marca falla aunque el cliente diga que no', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([RONDA])
      .mockResolvedValueOnce([PLANTILLA])
      .mockResolvedValueOnce([{ id: 'resp-1' }])
      .mockResolvedValueOnce([{ id: 'sup-1', email: 'sup@empresa.cl' }])
      .mockResolvedValueOnce([{ site_name: 'Planta Sur', guard_name: 'Ana Díaz' }]);
    const { service, enqueue, publish } = servicio(query);

    const resultado = await service.saveResponses('patrol-1', 'guard-1', {
      responses: [{ itemId: 'item-1', value: 'FALLA', failed: false, notes: 'Sin presión' }],
    });

    expect(resultado.results).toEqual([
      { itemId: 'item-1', status: 'aplicado', responseId: 'resp-1' },
    ]);
    expect(resultado.failed).toBe(1);

    const insert = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('INSERT INTO checklist_responses'),
    ) as [string, unknown[]];
    expect(insert[1][2]).toBe('falla');
    expect(insert[1][4]).toBe(true);

    expect(publish).toHaveBeenCalledWith(
      't-1',
      expect.objectContaining({
        type: 'checklist_falla',
        siteId: 'site-1',
        responseId: 'resp-1',
        itemLabel: 'Extintor de la bodega',
      }),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'sup@empresa.cl', tenantId: 't-1' }),
      { idempotencyKey: 'checklist-fail:resp-1:sup@empresa.cl' },
    );
  });

  it('un "ok" no avisa a nadie', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([RONDA])
      .mockResolvedValueOnce([PLANTILLA])
      .mockResolvedValueOnce([{ id: 'resp-1' }]);
    const { service, enqueue, publish } = servicio(query);

    const resultado = await service.saveResponses('patrol-1', 'guard-1', {
      responses: [{ itemId: 'item-1', value: 'ok' }],
    });

    expect(resultado.failed).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it('un item ajeno a la plantilla se rechaza sin escribir nada', async () => {
    const query = jest.fn().mockResolvedValueOnce([RONDA]).mockResolvedValueOnce([PLANTILLA]);
    const { service } = servicio(query);

    const resultado = await service.saveResponses('patrol-1', 'guard-1', {
      responses: [{ itemId: 'item-de-otra-plantilla', value: 'ok' }],
    });

    expect(resultado.results[0]?.status).toBe('rechazado');
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('un item invalido no bota a los que si eran validos', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([RONDA])
      .mockResolvedValueOnce([PLANTILLA])
      .mockResolvedValueOnce([{ id: 'resp-1' }]);
    const { service } = servicio(query);

    const resultado = await service.saveResponses('patrol-1', 'guard-1', {
      responses: [
        { itemId: 'item-1', value: 'tal vez' },
        { itemId: 'item-2', value: 'ok' },
      ],
    });

    expect(resultado.results.map((r) => r.status)).toEqual(['rechazado', 'aplicado']);
  });

  it('el item que exige foto al fallar se rechaza si no la trae', async () => {
    const query = jest.fn().mockResolvedValueOnce([RONDA]).mockResolvedValueOnce([PLANTILLA]);
    const { service, enqueue } = servicio(query);

    const resultado = await service.saveResponses('patrol-1', 'guard-1', {
      responses: [{ itemId: 'item-2', value: 'falla' }],
    });

    expect(resultado.results[0]).toEqual({
      itemId: 'item-2',
      status: 'rechazado',
      reason: 'Este item exige foto cuando se marca falla',
    });
    expect(query).toHaveBeenCalledTimes(2);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it.each(['ok', 'falla'] as const)(
    'el item requiresPhoto se rechaza sin foto aunque la respuesta sea %s (#299)',
    async (value) => {
      const query = jest
        .fn()
        .mockResolvedValueOnce([RONDA])
        .mockResolvedValueOnce([{ ...PLANTILLA, items: [ITEM_CON_FOTO_SIEMPRE] }]);
      const { service, enqueue } = servicio(query);

      const resultado = await service.saveResponses('patrol-1', 'guard-1', {
        responses: [{ itemId: ITEM_CON_FOTO_SIEMPRE.id, value }],
      });

      expect(resultado.results).toEqual([{
        itemId: ITEM_CON_FOTO_SIEMPRE.id,
        status: 'rechazado',
        reason: 'Este item exige foto',
      }]);
      // Ronda + plantilla: no escribe ni busca evidencia que no vino.
      expect(query).toHaveBeenCalledTimes(2);
      expect(enqueue).not.toHaveBeenCalled();
    },
  );

  it('el item requiresPhoto acepta una foto que pertenece a la misma ronda (#299)', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([RONDA])
      .mockResolvedValueOnce([{ ...PLANTILLA, items: [ITEM_CON_FOTO_SIEMPRE] }])
      .mockResolvedValueOnce([{ id: 'foto-ronda' }])
      .mockResolvedValueOnce([{ id: 'resp-1' }]);
    const { service } = servicio(query);

    const resultado = await service.saveResponses('patrol-1', 'guard-1', {
      responses: [{
        itemId: ITEM_CON_FOTO_SIEMPRE.id,
        value: 'ok',
        photoId: 'foto-ronda',
      }],
    });

    expect(resultado.results).toEqual([{
      itemId: ITEM_CON_FOTO_SIEMPRE.id,
      status: 'aplicado',
      responseId: 'resp-1',
    }]);
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('FROM scan_photos'),
      ['foto-ronda', 'patrol-1'],
    );
    expect(query).toHaveBeenNthCalledWith(
      4,
      expect.stringContaining('INSERT INTO checklist_responses'),
      [
        'patrol-1',
        ITEM_CON_FOTO_SIEMPRE.id,
        'ok',
        null,
        false,
        'foto-ronda',
        null,
      ],
    );
  });

  it('una foto de otra ronda no sirve como evidencia', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([RONDA])
      .mockResolvedValueOnce([PLANTILLA])
      .mockResolvedValueOnce([]); // la foto no pertenece a esta ronda
    const { service } = servicio(query);

    const resultado = await service.saveResponses('patrol-1', 'guard-1', {
      responses: [{ itemId: 'item-2', value: 'falla', photoId: 'foto-de-otra-ronda' }],
    });

    expect(resultado.results[0]?.reason).toBe('La foto no pertenece a esta ronda');
  });

  it('reenviar el lote offline no duplica la respuesta ni re-avisa', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([RONDA])
      .mockResolvedValueOnce([PLANTILLA])
      .mockResolvedValueOnce([]); // ON CONFLICT DO NOTHING
    const { service, enqueue } = servicio(query);

    const resultado = await service.saveResponses('patrol-1', 'guard-1', {
      responses: [{ itemId: 'item-1', value: 'falla' }],
    });

    expect(resultado.results).toEqual([{ itemId: 'item-1', status: 'duplicado' }]);
    expect(resultado.notified).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('con la regla del tenant apagada no manda correo, pero la bandeja igual se entera', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([RONDA])
      .mockResolvedValueOnce([PLANTILLA])
      .mockResolvedValueOnce([{ id: 'resp-1' }]);
    const { service, enqueue, publish } = servicio(query, { notificar: false });

    const resultado = await service.saveResponses('patrol-1', 'guard-1', {
      responses: [{ itemId: 'item-1', value: 'falla' }],
    });

    expect(resultado.notified).toBe(0);
    expect(enqueue).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalled();
  });

  it('un fallo de correo no bota la respuesta ya registrada', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([RONDA])
      .mockResolvedValueOnce([PLANTILLA])
      .mockResolvedValueOnce([{ id: 'resp-1' }])
      .mockResolvedValueOnce([{ id: 'sup-1', email: 'sup@empresa.cl' }])
      .mockResolvedValueOnce([{ site_name: 'Planta Sur', guard_name: 'Ana Díaz' }]);
    const enqueue = jest.fn().mockRejectedValue(new Error('redis caido'));
    const { service } = servicio(query, { enqueue });

    const resultado = await service.saveResponses('patrol-1', 'guard-1', {
      responses: [{ itemId: 'item-1', value: 'falla' }],
    });

    expect(resultado.results[0]?.status).toBe('aplicado');
    expect(resultado.notified).toBe(0);
  });

  it('una ronda sin checklist vigente no acepta respuestas', async () => {
    const query = jest.fn().mockResolvedValueOnce([RONDA]).mockResolvedValueOnce([]);
    const { service } = servicio(query);

    await expect(
      service.saveResponses('patrol-1', 'guard-1', {
        responses: [{ itemId: 'item-1', value: 'ok' }],
      }),
    ).rejects.toThrow(ConflictException);
  });
});

describe('ChecklistsService — administracion de plantillas (#129)', () => {
  it('un checklist por turno sin recinto se rechaza antes de tocar la base', async () => {
    const query = jest.fn();
    const { service } = servicio(query);

    await expect(
      service.createTemplate({ name: 'Nocturna', shiftId: 'shift-1', items: [] }),
    ).rejects.toThrow(BadRequestException);
    expect(query).not.toHaveBeenCalled();
  });

  it('dos checklists vigentes para el mismo alcance es 409, no un choque de indice', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ id: 'tpl-existente' }]);
    const { service } = servicio(query);

    await expect(
      service.createTemplate({
        name: 'Nocturna',
        siteId: 'site-1',
        items: [{ label: 'Extintor', responseType: 'ok_falla' }],
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('crea la plantilla con la posicion de cada item tomada del orden del arreglo', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const { service } = servicio(query);

    await service.createTemplate({
      name: 'Nocturna',
      siteId: 'site-1',
      items: [
        { label: 'Extintor', responseType: 'ok_falla' },
        { label: 'Nivel de estanque', responseType: 'numero' },
      ],
    });

    const items = query.mock.calls.filter(([sql]: [string]) =>
      sql.includes('INSERT INTO checklist_items'),
    ) as Array<[string, unknown[]]>;
    expect(items).toHaveLength(2);
    expect(items[0]?.[1][1]).toBe(1);
    expect(items[1]?.[1][1]).toBe(2);
  });

  it('cambiar los items de un checklist ya respondido es 409', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'tpl-1' }])
      .mockResolvedValueOnce([{ id: 'resp-1' }]);
    const { service } = servicio(query);

    await expect(
      service.updateTemplate('tpl-1', {
        items: [{ label: 'Otro punto', responseType: 'ok_falla' }],
      }),
    ).rejects.toThrow(ConflictException);

    const sqls = query.mock.calls.map(([sql]: [string]) => sql);
    expect(sqls.some((sql: string) => /DELETE\s+FROM\s+checklist_items/.test(sql))).toBe(false);
  });
});

/**
 * La plantilla que viaja al TELEFONO (#265).
 *
 * Estas dos pruebas miran el SQL y no lo que devuelve el mock, a proposito: el
 * mock devuelve lo que el autor escribio en `PLANTILLA`, asi que confirmar la
 * forma del objeto no prueba que la consulta traiga las columnas. Es el error
 * que ya tumbo un endpoint entero en produccion con 1900 pruebas en verde. Los
 * nombres de columna se leen de la MIGRACION, que es la unica fuente que la base
 * respeta.
 */
function columnasAgregadasAChecklistItems(): string[] {
  const carpeta = join(__dirname, '..', 'database', 'migrations');
  // Por nombre de clase y no por sello: el sello se elige al final y renumerar
  // es seguro mientras no se haya aplicado (CLAUDE.md), asi que fijarlo aca
  // romperia la prueba por un cambio que no cambia nada.
  const archivo = readdirSync(carpeta).find((nombre) => nombre.endsWith('-TareasDelTurno.ts'));
  if (!archivo) throw new Error('No esta la migracion de tareas del turno');

  const migracion = readFileSync(join(carpeta, archivo), 'utf8');
  const columnas: string[] = [];
  for (const bloque of migracion.split(/ALTER TABLE\s+/g).slice(1)) {
    if (!bloque.startsWith('checklist_items')) continue;
    for (const [, columna] of bloque.matchAll(/ADD COLUMN\s+(\w+)/g)) {
      if (columna) columnas.push(columna);
    }
  }
  return columnas;
}

describe('ChecklistsService — la plantilla que viaja al telefono (#265)', () => {
  async function sqlDeLaPlantilla(): Promise<string> {
    const query = jest
      .fn()
      .mockResolvedValueOnce([RONDA])
      .mockResolvedValueOnce([{ ...PLANTILLA, items: [TAREA_DEL_PUNTO] }]);
    const { service } = servicio(query);
    await service.templateForPatrol('patrol-1', 'guard-1');
    const [sql] = query.mock.calls[1] as [string];
    return sql;
  }

  it('proyecta TODAS las columnas que la migracion agrego a checklist_items', async () => {
    const columnas = columnasAgregadasAChecklistItems();
    // Que el lector de la migracion funcione es parte de la prueba: si dejara de
    // encontrar columnas, el bucle de abajo pasaria sin comprobar nada.
    expect(columnas).toEqual(
      expect.arrayContaining(['checkpoint_id', 'due_local_time', 'requires_photo']),
    );

    const sql = await sqlDeLaPlantilla();
    for (const columna of columnas) expect(sql).toContain(`i.${columna}`);
  });

  it('la tarea llega con su punto, su hora y su foto obligatoria, con esos nombres', async () => {
    const sql = await sqlDeLaPlantilla();
    // Las claves del jsonb son el contrato con el telefono: una columna
    // proyectada con otro nombre es una tarea que el guardia nunca ve al
    // escanear el punto, aunque el SELECT la traiga.
    for (const clave of Object.keys(TAREA_DEL_PUNTO)) expect(sql).toContain(`'${clave}',`);
  });
});

/**
 * El atraso de una tarea con hora (#265).
 *
 * Las fechas del fixture son las que devolveria PostgreSQL para un turno de
 * 22:00 a 06:00 del viernes 7-ago-2026 en un recinto de Santiago (UTC-4 en
 * invierno). El offset vive solo aca: en produccion la conversion la hace
 * `AT TIME ZONE sites.timezone` y nadie escribe un offset en el codigo.
 */
const VENTANA_DEL_TURNO = {
  ventana_inicio: new Date('2026-08-08T02:00:00Z'), // viernes 22:00 local
  ventana_fin: new Date('2026-08-08T10:00:00Z'), // sabado 06:00 local
};

/** La respuesta llega a las 02:00 locales del sabado. */
const AHORA = new Date('2026-08-08T06:00:00Z');

function filaDeVencimiento(itemId: string, delDia: string, delDiaSiguiente: string) {
  return {
    item_id: itemId,
    ahora: AHORA,
    ...VENTANA_DEL_TURNO,
    vence_del_dia: new Date(delDia),
    vence_del_dia_siguiente: new Date(delDiaSiguiente),
  };
}

const TAREA_DE_LAS_23: ChecklistItemView = {
  id: 'item-tarea',
  position: 1,
  label: 'Fotografiar el refrigerador',
  responseType: 'ok_falla',
  requiresPhotoOnFail: false,
  checkpointId: null,
  dueLocalTime: '23:00:00',
  requiresPhoto: false,
};

const PLANTILLA_CON_TAREA = { ...PLANTILLA, items: [TAREA_DE_LAS_23] };

describe('ChecklistsService — la tarea que llega tarde se acepta igual (#265)', () => {
  it('guarda los minutos de atraso en late_minutes y NO rechaza la respuesta', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([RONDA])
      .mockResolvedValueOnce([PLANTILLA_CON_TAREA])
      .mockResolvedValueOnce([
        // Tarea de las 23:00 del viernes: el candidato del dia cae dentro del
        // turno, el del dia siguiente no.
        filaDeVencimiento('item-tarea', '2026-08-08T03:00:00Z', '2026-08-09T03:00:00Z'),
      ])
      .mockResolvedValueOnce([{ id: 'resp-1' }]);
    const { service } = servicio(query);

    const resultado = await service.saveResponses('patrol-1', 'guard-1', {
      responses: [{ itemId: 'item-tarea', value: 'ok' }],
    });

    // 23:00 pedidas, respondida a las 02:00: tres horas, no veintiuna.
    expect(resultado.results[0]).toEqual({
      itemId: 'item-tarea',
      status: 'aplicado',
      responseId: 'resp-1',
      lateMinutes: 180,
      outsideShift: false,
      lateMessage: expect.stringContaining('180 min'),
    });
    expect(resultado.late).toBe(1);

    const insert = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('INSERT INTO checklist_responses'),
    ) as [string, unknown[]];
    expect(insert[0]).toContain('late_minutes');
    expect(insert[1][6]).toBe(180);
  });

  it('una tarea SIN hora guarda NULL, no cero, y no paga una consulta de mas', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([RONDA])
      .mockResolvedValueOnce([PLANTILLA]) // ITEM_SIMPLE no tiene dueLocalTime
      .mockResolvedValueOnce([{ id: 'resp-1' }]);
    const { service } = servicio(query);

    const resultado = await service.saveResponses('patrol-1', 'guard-1', {
      responses: [{ itemId: 'item-1', value: 'ok' }],
    });

    expect(resultado.results[0]).not.toHaveProperty('lateMinutes');
    const insert = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('INSERT INTO checklist_responses'),
    ) as [string, unknown[]];
    expect(insert[1][6]).toBeNull();
    // Ronda, plantilla e INSERT: sin horas no se resuelve ningun vencimiento.
    expect(query).toHaveBeenCalledTimes(3);
  });

  it('la tarea cuya hora cae fuera del horario de la ronda se acepta y lo dice', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([RONDA])
      .mockResolvedValueOnce([
        { ...PLANTILLA, items: [{ ...TAREA_DE_LAS_23, dueLocalTime: '11:00:00' }] },
      ])
      .mockResolvedValueOnce([
        // Las 11:00 no ocurren nunca dentro de un turno de 22:00 a 06:00.
        filaDeVencimiento('item-tarea', '2026-08-07T15:00:00Z', '2026-08-08T15:00:00Z'),
      ])
      .mockResolvedValueOnce([{ id: 'resp-1' }]);
    const { service } = servicio(query);

    const resultado = await service.saveResponses('patrol-1', 'guard-1', {
      responses: [{ itemId: 'item-tarea', value: 'ok' }],
    });

    expect(resultado.results[0]?.status).toBe('aplicado');
    expect(resultado.results[0]?.outsideShift).toBe(true);
    expect(resultado.results[0]?.lateMessage).toContain('fuera del horario de la ronda');
    const insert = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('INSERT INTO checklist_responses'),
    ) as [string, unknown[]];
    // Cero, no NULL: la tarea SI tenia hora y se respondio antes de ella.
    expect(insert[1][6]).toBe(0);
  });

  it('el dia siguiente se suma al timestamp SIN zona, y los ids van como uuid[]', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([RONDA])
      .mockResolvedValueOnce([PLANTILLA_CON_TAREA])
      .mockResolvedValueOnce([
        filaDeVencimiento('item-tarea', '2026-08-08T03:00:00Z', '2026-08-09T03:00:00Z'),
      ])
      .mockResolvedValueOnce([{ id: 'resp-1' }]);
    const { service } = servicio(query);

    await service.saveResponses('patrol-1', 'guard-1', {
      responses: [{ itemId: 'item-tarea', value: 'ok' }],
    });

    const [sql, parametros] = query.mock.calls[2] as [string, unknown[]];
    // Convertir primero y sumar el dia despues corre una hora en cada cambio de
    // horario: el INTERVAL va ANTES del AT TIME ZONE, sobre el timestamp local.
    expect(sql).toContain(`+ INTERVAL '1 day') AT TIME ZONE`);
    // El arreglo se compara contra la columna uuid con el casteo escrito; un
    // `= ANY(...)` mal tipado compila en TypeScript y revienta en la base.
    expect(sql).toContain('= ANY($2::uuid[])');
    expect(parametros).toEqual(['patrol-1', ['item-tarea']]);
  });
});
