import { BadRequestException } from '@nestjs/common';
import { patrolRulesSchema, type PatrolRules } from '@voxia/shared';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { EventsStreamService } from '../events-stream/events-stream.service';
import type { MailQueueService } from '../mail/mail-queue.service';
import type { RulesService } from '../rules/rules.service';
import { ChecklistsService } from './checklists.service';

/**
 * El lado de ESCRITURA de las tareas del turno (#265): lo que el editor del
 * supervisor guarda.
 *
 * Vive en su propio archivo y no dentro de `checklists.service.spec.ts` para no
 * pelear con el carril que trabaja el lado de LECTURA en ese mismo archivo. Las
 * dos mitades tienen que existir: una tarea que se lee pero no se escribe es una
 * columna vacia, y una que se escribe pero no se lee es una tarea que el guardia
 * nunca ve.
 */
function servicio(query: jest.Mock) {
  const service = new ChecklistsService(
    { manager: { query } } as unknown as TenantContextService,
    { enqueue: jest.fn() } as unknown as MailQueueService,
    {
      effective: jest.fn().mockResolvedValue(patrolRulesSchema.parse({}) as PatrolRules),
    } as unknown as RulesService,
    { publish: jest.fn() } as unknown as EventsStreamService,
  );
  return { service };
}

/** La tarea del requisito, textual: a las 11, en ese punto, con foto. */
const TAREA_DEL_REFRIGERADOR = {
  label: 'Fotografiar el refrigerador',
  responseType: 'ok_falla' as const,
  checkpointId: '5b0f5a6e-4e0f-4d5f-9a71-2f6e8d0f1a22',
  dueLocalTime: '11:00',
  requiresPhoto: true,
};

function insertsDeItems(query: jest.Mock): Array<[string, unknown[]]> {
  return query.mock.calls.filter(([sql]: [string]) =>
    sql.includes('INSERT INTO checklist_items'),
  ) as Array<[string, unknown[]]>;
}

/**
 * Los nombres de columna se leen de la MIGRACION y no del mock: un mock no sabe
 * SQL y confirma lo que el autor ya creia. Por nombre de clase y no por sello,
 * porque el sello se elige al final y renumerar es seguro (CLAUDE.md).
 */
function columnasAgregadasAChecklistItems(): string[] {
  const carpeta = join(__dirname, '..', 'database', 'migrations');
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

describe('ChecklistsService — guardar una tarea con punto, hora y foto (#265)', () => {
  function queryDeCreacionFeliz() {
    return (
      jest
        .fn()
        // verificarAlcanceLibre: no hay otra plantilla vigente para ese alcance
        .mockResolvedValueOnce([])
        // INSERT checklist_templates
        .mockResolvedValueOnce([])
        // verificarLugarYHora: el punto SI es del recinto y esta activo
        .mockResolvedValueOnce([{ id: TAREA_DEL_REFRIGERADOR.checkpointId }])
        // INSERT checklist_items
        .mockResolvedValueOnce([])
    );
  }

  it('escribe las tres columnas que agrego la migracion, con esos nombres', async () => {
    const query = queryDeCreacionFeliz();
    const { service } = servicio(query);

    await service.createTemplate({
      name: 'Tareas del turno',
      siteId: 'site-1',
      items: [TAREA_DEL_REFRIGERADOR],
    });

    const columnas = columnasAgregadasAChecklistItems();
    // Que el lector de la migracion funcione es parte de la prueba: si dejara de
    // encontrar columnas, el bucle de abajo pasaria sin comprobar nada.
    expect(columnas).toEqual(
      expect.arrayContaining(['checkpoint_id', 'due_local_time', 'requires_photo']),
    );

    const inserts = insertsDeItems(query);
    expect(inserts).toHaveLength(1);
    const [sql] = inserts[0]!;
    for (const columna of columnas) expect(sql).toContain(columna);
  });

  it('manda el punto, la hora y la foto obligatoria como valores, no solo como columnas', async () => {
    const query = queryDeCreacionFeliz();
    const { service } = servicio(query);

    await service.createTemplate({
      name: 'Tareas del turno',
      siteId: 'site-1',
      items: [TAREA_DEL_REFRIGERADOR],
    });

    const [, parametros] = insertsDeItems(query)[0]!;
    // Declarar la columna y no llenarla deja la tarea sin lugar ni hora, que es
    // exactamente el defecto que esto vigila.
    expect(parametros).toEqual([
      expect.any(String), // templateId
      1, // position
      'Fotografiar el refrigerador',
      'ok_falla',
      false, // requiresPhotoOnFail
      TAREA_DEL_REFRIGERADOR.checkpointId,
      '11:00',
      true, // requiresPhoto
    ]);
  });

  it('una tarea con checkpointId NULL en una plantilla de toda la empresa no es un error', async () => {
    /*
     * El caso que un formulario web produce de verdad: los campos vacios se
     * mandan como `null`, no se omiten. Y una plantilla de toda la empresa
     * lleva `siteId: null`.
     *
     * Con la version anterior (`item.checkpointId !== undefined`) ese `null`
     * entraba en el filtro de "tareas con lugar u hora" y se llevaba un 400
     * —"necesita una plantilla de recinto"— cuando justamente no habia pedido
     * ningun recinto. El editor del supervisor no habria podido guardar una
     * sola tarea general.
     *
     * La prueba que existia no lo cazaba: OMITIA la clave (undefined) y usaba
     * un recinto, asi que nunca llegaba a esta rama y pasaba con y sin el
     * arreglo. Verificada en rojo: con `!== undefined` esto tira 400.
     */
    const query = jest.fn().mockResolvedValue([]);
    const { service } = servicio(query);

    await expect(
      service.createTemplate({
        name: 'Tareas de toda la empresa',
        siteId: null,
        items: [
          {
            label: 'Revisar el libro de novedades',
            responseType: 'ok_falla',
            checkpointId: null,
            dueLocalTime: null,
          },
        ],
      } as unknown as Parameters<ChecklistsService['createTemplate']>[0]),
    ).resolves.not.toThrow();

    // Y se guarda como tarea general: sin punto, sin hora.
    const [, parametros] = insertsDeItems(query)[0]!;
    expect(parametros.slice(5)).toEqual([null, null, false]);
  });

  it('una tarea sin punto ni hora sigue guardandose como tarea general del turno', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const { service } = servicio(query);

    await service.createTemplate({
      name: 'Tareas del turno',
      siteId: 'site-1',
      items: [{ label: 'Extintor de la bodega', responseType: 'ok_falla' }],
    });

    const [, parametros] = insertsDeItems(query)[0]!;
    expect(parametros.slice(5)).toEqual([null, null, false]);
    // Y no se consulto ningun punto: no hay nada que comprobar.
    const consultasDePuntos = query.mock.calls.filter(([sql]: [string]) =>
      sql.includes('FROM checkpoints'),
    );
    expect(consultasDePuntos).toHaveLength(0);
  });
});

describe('ChecklistsService — una tarea no puede apuntar a cualquier parte (#265)', () => {
  it('un punto de OTRO recinto se rechaza con 400 y no escribe ningun item', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([]) // verificarAlcanceLibre
      .mockResolvedValueOnce([]) // INSERT checklist_templates
      .mockResolvedValueOnce([]); // el punto no es de este recinto: cero filas
    const { service } = servicio(query);

    await expect(
      service.createTemplate({
        name: 'Tareas del turno',
        siteId: 'site-1',
        items: [TAREA_DEL_REFRIGERADOR],
      }),
    ).rejects.toThrow(BadRequestException);

    // El rechazo llega ANTES del INSERT: una sentencia que falla abortaria la
    // transaccion completa del request.
    expect(insertsDeItems(query)).toHaveLength(0);
  });

  it('la comprobacion del punto compara contra el recinto de la plantilla', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: TAREA_DEL_REFRIGERADOR.checkpointId }])
      .mockResolvedValueOnce([]);
    const { service } = servicio(query);

    await service.createTemplate({
      name: 'Tareas del turno',
      siteId: 'site-1',
      items: [TAREA_DEL_REFRIGERADOR],
    });

    const consulta = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('FROM checkpoints'),
    ) as [string, unknown[]];
    // `= ANY($1::uuid[])` sobre la columna uuid: el casteo escrito es lo que
    // separa esta consulta de un `= ANY(jsonb)`, que compila y revienta en la
    // base.
    expect(consulta[0]).toContain('id = ANY($1::uuid[])');
    expect(consulta[0]).toContain('site_id = $2');
    expect(consulta[0]).toContain('is_active');
    expect(consulta[1]).toEqual([[TAREA_DEL_REFRIGERADOR.checkpointId], 'site-1']);
  });

  it('una hora sin recinto se rechaza: "11:00" de toda la empresa no tiene zona', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const { service } = servicio(query);

    await expect(
      service.createTemplate({
        name: 'Tareas de la empresa',
        items: [{ label: 'Revisar la bomba', responseType: 'ok_falla', dueLocalTime: '11:00' }],
      }),
    ).rejects.toThrow(BadRequestException);

    expect(insertsDeItems(query)).toHaveLength(0);
  });

  it('al reemplazar los items de una plantilla, el punto se compara con SU recinto', async () => {
    const query = jest
      .fn()
      // SELECT id, site_id FROM checklist_templates
      .mockResolvedValueOnce([{ id: 'tpl-1', site_id: 'site-de-la-plantilla' }])
      // no hay respuestas registradas
      .mockResolvedValueOnce([])
      // DELETE de los items viejos
      .mockResolvedValueOnce([])
      // verificarLugarYHora
      .mockResolvedValueOnce([{ id: TAREA_DEL_REFRIGERADOR.checkpointId }])
      // INSERT del item nuevo
      .mockResolvedValueOnce([])
      // UPDATE checklist_templates
      .mockResolvedValueOnce([])
      // getTemplate
      .mockResolvedValueOnce([
        { id: 'tpl-1', name: 'Tareas', site_id: 'site-de-la-plantilla', shift_id: null, is_active: true, items: [] },
      ]);
    const { service } = servicio(query);

    await service.updateTemplate('tpl-1', { items: [TAREA_DEL_REFRIGERADOR] });

    const consulta = query.mock.calls.find(([sql]: [string]) =>
      sql.includes('FROM checkpoints'),
    ) as [string, unknown[]];
    // El recinto sale de la fila guardada y no del cuerpo del request: el
    // alcance de una plantilla no se edita.
    expect(consulta[1]).toEqual([[TAREA_DEL_REFRIGERADOR.checkpointId], 'site-de-la-plantilla']);
  });
});

describe('ChecklistsService — listado acotado a un recinto (#265)', () => {
  it('con recinto filtra por ese recinto; sin recinto devuelve el tenant completo', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const { service } = servicio(query);

    await service.listTemplates('site-1');
    expect((query.mock.calls[0] as [string, unknown[]])[1]).toEqual(['site-1']);
    expect((query.mock.calls[0] as [string])[0]).toContain('t.site_id = $1::uuid');

    await service.listTemplates();
    expect((query.mock.calls[1] as [string, unknown[]])[1]).toEqual([null]);
  });
});
