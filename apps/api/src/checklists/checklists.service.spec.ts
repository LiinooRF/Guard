import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { patrolRulesSchema, type PatrolRules } from '@voxia/shared';

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
};

const ITEM_CON_FOTO: ChecklistItemView = {
  id: 'item-2',
  position: 2,
  label: 'Puerta de acceso norte',
  responseType: 'ok_falla',
  requiresPhotoOnFail: true,
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
  const enqueue = opciones.enqueue ?? jest.fn().mockResolvedValue({ jobId: 'mail-job' });
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
