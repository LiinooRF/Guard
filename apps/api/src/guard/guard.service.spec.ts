import { ForbiddenException } from '@nestjs/common';
import { patrolRulesSchema } from '@voxia/shared';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GpsPolicyService } from '../geo/gps-policy.service';
import type { EnvioInformeService } from '../reports/envio-informe.service';
import { GuardService } from './guard.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { EscalationService } from '../escalation/escalation.service';
import type { EvidenceService } from '../evidence/evidence.service';
import type { MailQueueService } from '../mail/mail-queue.service';
import type { RulesService } from '../rules/rules.service';

const sinCorreo = () =>
  ({ enqueue: jest.fn().mockResolvedValue({ jobId: 'mail-job' }) }) as
    unknown as MailQueueService;

/** Motor de reglas sin overrides: responde los defaults del producto (#16). */
const sinReglas = () =>
  ({ effective: jest.fn().mockResolvedValue(patrolRulesSchema.parse({})) }) as
    unknown as RulesService;

/**
 * La puerta de GPS (#77) se prueba entera en gps-policy.service.spec.ts. Aca
 * solo tiene que dejar pasar: si estos tests dependieran de su veredicto,
 * probarian dos cosas a la vez y fallarian por el motivo equivocado.
 */
/**
 * El envio del informe se prueba entero en el carril de #86. Aca solo tiene que
 * dejarse llamar: si estos tests dependieran de que encole, probarian dos cosas
 * a la vez y fallarian por el motivo equivocado.
 */
const sinEnvioInforme = () =>
  ({ alCerrarRonda: jest.fn().mockResolvedValue({ jobId: 'job' }) }) as unknown as EnvioInformeService;

const sinPuertaGps = () =>
  ({ assertPatrolStartAllowed: jest.fn().mockResolvedValue(undefined) }) as unknown as GpsPolicyService;

const sinEscalamiento = (notificados = 0) =>
  ({ notify: jest.fn().mockResolvedValue(notificados) }) as unknown as EscalationService;

describe('GuardService', () => {
  it('indica claramente cuando el guardia no tiene turno', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinPuertaGps(), sinEnvioInforme());

    await expect(service.getHome('guard-id')).resolves.toMatchObject({
      hasAssignment: false,
      message: 'No tienes un turno asignado en este momento.',
    });
  });

  it('devuelve la ronda asignada sin datos de otros guardias', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([
        {
          id: 'patrol-id',
          status: 'pendiente',
          // Ventana VIGENTE, relativa a ahora. Con fechas fijas del pasado esta
          // ronda venceria (patrol-expiry.ts) y el test probaria otra cosa.
          scheduled_start_at: new Date(Date.now() - 60 * 60_000),
          scheduled_end_at: new Date(Date.now() + 7 * 3_600_000),
          started_at: null,
          site_id: 'site-id',
          // Lo calcula el SQL. Este spec fijaba `completedCheckpointCount: 0`
          // cuando el servicio tenia un cero ESCRITO A MANO: el test protegia
          // al placeholder. Ahora exige que el valor de la fila pase entero.
          completed_checkpoint_count: 1,
          site_name: 'Recinto demostración',
          route_name: 'Ronda nocturna demo',
          estimated_duration_min: 30,
          checkpoints: [
            {
              id: 'checkpoint-id', name: 'Acceso', position: 1,
              isClosingPoint: true, tagUids: ['04AABBCC'],
              scannedAt: '2026-08-08T02:10:00.000Z',
            },
          ],
        },
      ]),
    };
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinPuertaGps(), sinEnvioInforme());

    await expect(service.getHome('guard-id')).resolves.toMatchObject({
      hasAssignment: true,
      patrol: {
        id: 'patrol-id',
        completedCheckpointCount: 1,
        checkpoints: [{ name: 'Acceso', scannedAt: '2026-08-08T02:10:00.000Z' }],
      },
    });
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('p.guard_id = $1'), [
      'guard-id',
    ]);
  });

  it('vence al mirarla la ronda que quedo abierta de un turno pasado', async () => {
    // El caso real de staging: iniciada hace 48 horas, "tu turno" dos dias
    // despues. Al cargar home, la ronda se vence y el guardia ya no la ve.
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([{
        id: 'patrol-id',
        status: 'en_curso',
        scheduled_start_at: new Date(Date.now() - 49 * 3_600_000),
        scheduled_end_at: new Date(Date.now() - 41 * 3_600_000),
        started_at: new Date(Date.now() - 48 * 3_600_000),
        site_id: 'site-id',
        site_name: 'Recinto demostración',
        route_name: 'Ronda nocturna demo',
        estimated_duration_min: 30,
        checkpoints: [],
      }])
      .mockResolvedValueOnce([]); // UPDATE a vencida
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinPuertaGps(), sinEnvioInforme());

    await expect(service.getHome('guard-id')).resolves.toMatchObject({
      hasAssignment: false,
      message: expect.stringContaining('venció'),
    });
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'vencida'"),
      ['patrol-id'],
    );
  });

  // Un mock devuelve lo que le pidas y no sabe SQL: el GROUP BY se puede romper
  // entero con los 101 tests en verde. Paso `s.timezone` a la respuesta y agrupe
  // por `p.site_id` en vez de `s.id`; site_id es columna de patrols, no la clave
  // de sites, asi que Postgres respondia 42803 y GET /guard/home devolvia 500
  // para TODOS los guardias. Aca se comprueba la unica regla que importa: si se
  // selecciona una columna de una tabla, esa tabla aparece en el GROUP BY POR SU
  // CLAVE PRIMARIA, que es lo que habilita la dependencia funcional.
  it('agrupa por las claves primarias de cada tabla de la que selecciona columnas', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinPuertaGps(), sinEnvioInforme());

    await service.getHome('guard-id');
    // Se quitan los comentarios `--` antes de mirar: si no, el propio comentario
    // que explica el bug contendria los nombres y el test pasaria solo.
    const sql = (manager.query.mock.calls[0]?.[0] as string).replace(/--.*$/gm, '');
    const seleccion = sql.slice(0, sql.search(/GROUP BY/i));
    const agrupadas = (/GROUP BY([\s\S]*?)(?:ORDER BY|LIMIT|$)/i.exec(sql)?.[1] ?? '')
      .split(',')
      .map((columna) => columna.trim())
      .filter(Boolean);

    for (const [alias, clave] of [['p', 'p.id'], ['s', 's.id'], ['r', 'r.id']] as const) {
      if (new RegExp(`\\b${alias}\\.[a-z_]+`).test(seleccion)) {
        expect(agrupadas).toContain(clave);
      }
    }
  });

  it('inicia únicamente una ronda pendiente asignada al guardia autenticado', async () => {
    const manager = {
      query: jest.fn().mockResolvedValue([
        { id: 'patrol-id', status: 'en_curso', started_at: new Date() },
      ]),
    };
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinPuertaGps(), sinEnvioInforme());

    await expect(service.startPatrol('patrol-id', 'guard-id')).resolves.toMatchObject({
      status: 'en_curso',
    });
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining("status = 'pendiente'"), [
      'patrol-id',
      'guard-id',
    ]);
  });
});

describe('GuardService.registerScan', () => {
  it('la tolerancia de reloj sale de la regla, no de un numero fijo', async () => {
    // Estaba quemada en 5 minutos, mientras SyncService ya usaba
    // `clockSkewToleranceMin` para ESTA misma comprobacion: el mismo escaneo
    // salia marcado o limpio segun por donde entrara. Con la regla en 30, un
    // desfase de 10 minutos NO es anomalia; con la regla en 1, si.
    async function anomaliasCon(toleranciaMin: number, desfaseMin: number) {
      const manager = { query: jest.fn() };
      manager.query
        .mockResolvedValueOnce([PATROL])
        .mockResolvedValueOnce([{
          tag_id: 'tag-id', checkpoint_id: 'cp-1', checkpoint_name: 'Acceso',
          kind: 'normal', latitude: null, longitude: null, is_closing_point: false,
        }])
        .mockResolvedValueOnce([{ id: 'scan-id' }])
        .mockResolvedValueOnce([{ checkpoint_id: 'cp-1', anomalies: [] }]);
      const reglas = {
        effective: jest.fn().mockResolvedValue(
          patrolRulesSchema.parse({ clockSkewToleranceMin: toleranciaMin }),
        ),
      } as unknown as RulesService;
      const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), reglas, sinEscalamiento(), sinPuertaGps(), sinEnvioInforme());
      await service.registerScan('patrol-id', 'guard-id', dto({
        scannedAt: new Date(Date.now() - desfaseMin * 60_000).toISOString(),
      }));
      const insercion = manager.query.mock.calls[2]?.[1] as unknown[];
      return JSON.stringify(insercion);
    }

    expect(await anomaliasCon(30, 10)).not.toContain('reloj_desfasado');
    expect(await anomaliasCon(1, 10)).toContain('reloj_desfasado');
  });

  it('resuelve la exigencia de foto ANTES de escribir, no despues', async () => {
    /*
     * No es una preferencia de estilo. `exigeFoto()` hace un SELECT y se traga su
     * error para no tumbar el escaneo — pero tragarse la excepcion de JavaScript
     * NO desaborta una transaccion que PostgreSQL ya marco, y todo el request
     * corre dentro de UNA.
     *
     * Con el SELECT despues del INSERT, la secuencia era: se inserta el escaneo,
     * se cierra la ronda, se encola el informe, falla el SELECT, el catch lo
     * silencia, y el COMMIT revienta con 25P02. El guardia recibia 500 y el
     * correo con el informe ya habia salido.
     *
     * Aca se comprueba el orden real: la consulta de evidencia tiene que ocurrir
     * antes de que se escriba una sola fila.
     */
    const orden: string[] = [];
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([PATROL])
      .mockResolvedValueOnce([{
        tag_id: 'tag-id', checkpoint_id: 'cp-1', checkpoint_name: 'Acceso',
        kind: 'acceso_critico', latitude: null, longitude: null, is_closing_point: false,
      }])
      .mockImplementation((sql: string) => {
        if (String(sql).includes('INSERT INTO scans')) orden.push('escribe');
        return Promise.resolve([{ id: 'scan-id' }]);
      });
    const evidencia = {
      requiresPhoto: jest.fn().mockImplementation(() => {
        orden.push('consulta-evidencia');
        return Promise.resolve({ required: true });
      }),
      isWithinBusinessHours: jest.fn().mockResolvedValue(true),
    };
    const service = new GuardService(
      { manager } as unknown as TenantContextService, sinCorreo(), sinReglas(),
      sinEscalamiento(), sinPuertaGps(), sinEnvioInforme(), undefined,
      evidencia as never,
    );

    await service.registerScan('patrol-id', 'guard-id', dto()).catch(() => undefined);

    expect(orden[0]).toBe('consulta-evidencia');
  });

  it('el arranque automatico pasa por la MISMA puerta de consentimiento que el boton', async () => {
    // El agujero que existia: `startPatrol()` exigia el consentimiento de
    // ubicacion, pero escanear con la ronda en 'pendiente' la arrancaba sola sin
    // preguntar. Bastaba no apretar el boton. Comprobado contra staging: con el
    // consentimiento en `nunca_aceptado`, `start` daba 403 y el escaneo 200.
    const puerta = {
      assertPatrolStartAllowed: jest.fn().mockRejectedValue(
        new ForbiddenException('Para iniciar la ronda tienes que aceptar el aviso de compartir ubicación.'),
      ),
    } as unknown as GpsPolicyService;
    const manager = { query: jest.fn().mockResolvedValueOnce([{ ...PATROL, status: 'pendiente' }]) };
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), puerta, sinEnvioInforme());

    await expect(service.registerScan('patrol-id', 'guard-id', dto())).rejects.toThrow(
      /aceptar el aviso/,
    );
    // Y no alcanzo a marcar la ronda como iniciada.
    expect(manager.query).toHaveBeenCalledTimes(1);
  });

  const PATROL = {
    id: 'patrol-id',
    status: 'en_curso',
    route_id: 'route-id',
    expected_checkpoint_ids: ['cp-1', 'cp-2'],
    site_id: 'site-id',
    // Recien iniciada: lejos de vencer. Los tests de vencimiento la envejecen.
    started_at: new Date(Date.now() - 30 * 60_000),
    scheduled_end_at: new Date(Date.now() + 6 * 3_600_000),
    closed_at: null,
  };
  const dto = (extra = {}) => ({
    uid: 'ABCD1234',
    method: 'nfc' as const,
    clientScanId: '3a0c8f7e-1111-4222-8333-444455556666',
    latitude: -33.45,
    longitude: -70.66,
    ...extra,
  });

  it('cierra la ronda sola al escanear el punto de cierre, con su cumplimiento', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([PATROL]) // la ronda del guardia
      .mockResolvedValueOnce([{
        tag_id: 'tag-id', checkpoint_id: 'cp-2', checkpoint_name: 'Porteria',
        kind: 'acceso_critico', latitude: '-33.45', longitude: '-70.66',
        is_closing_point: true,
      }]) // resolucion de la etiqueta
      .mockResolvedValueOnce([{ id: 'scan-id' }]) // insert
      .mockResolvedValueOnce([
        { checkpoint_id: 'cp-1', anomalies: [] },
        { checkpoint_id: 'cp-2', anomalies: [] },
      ]) // todos los escaneos de la ronda
      .mockResolvedValueOnce([]); // cierre
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinPuertaGps(), sinEnvioInforme());

    await expect(service.registerScan('patrol-id', 'guard-id', dto())).resolves.toMatchObject({
      replay: false,
      patrol: { status: 'completada', compliancePct: 100 },
      progress: { scanned: 2, expected: 2, pct: 100 },
    });
    // El estado sale de un CASE sobre el porcentaje: 'completada' solo al 100%.
    // Antes era un literal incondicional y una ronda al 40% quedaba "completada".
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining("CASE WHEN $2 >= 100 THEN 'completada' ELSE 'incompleta' END"),
      ['patrol-id', 100],
    );
  });

  it('cerrar con puntos faltantes deja la ronda incompleta, no completada', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([PATROL])
      .mockResolvedValueOnce([{
        tag_id: 'tag-id', checkpoint_id: 'cp-2', checkpoint_name: 'Porteria',
        kind: 'normal', latitude: null, longitude: null,
        is_closing_point: true,
      }])
      .mockResolvedValueOnce([{ id: 'scan-id' }])
      // Solo el punto de cierre esta escaneado: cp-1 falta, 50%.
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-2', anomalies: [] }])
      .mockResolvedValueOnce([]); // cierre
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinPuertaGps(), sinEnvioInforme());

    await expect(service.registerScan('patrol-id', 'guard-id', dto())).resolves.toMatchObject({
      patrol: { status: 'incompleta', compliancePct: 50 },
      progress: { scanned: 1, expected: 2, pct: 50 },
    });
  });

  it('una ronda mas vieja que maxPatrolDurationMin vence al escanearla y el escaneo se preserva', async () => {
    /*
     * El caso real de staging que motivo esto: una ronda de 22:00-06:00 siguio
     * `en_curso` 48 horas y acepto escaneos a mediodia del dia subsiguiente,
     * cerrando "completada" al 100%. Nadie escribia 'vencida', nunca.
     *
     * Y el detalle que importa tanto como el vencimiento: el escaneo NO se
     * pierde. Antes el camino directo respondia un 409 pelado y lo tiraba; el
     * mismo escaneo por la cola offline quedaba en late_scans. El guardia CON
     * señal era el que perdia su registro.
     */
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([{
        ...PATROL,
        started_at: new Date(Date.now() - 9 * 3_600_000), // 9 h > 480 min
      }])
      .mockResolvedValueOnce([]) // UPDATE a vencida
      .mockResolvedValueOnce([]); // INSERT en late_scans
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinPuertaGps(), sinEnvioInforme());

    await expect(service.registerScan('patrol-id', 'guard-id', dto()))
      .rejects.toThrow(/marca atrasada/);

    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'vencida'"),
      ['patrol-id'],
    );
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO late_scans'),
      expect.arrayContaining(['patrol-id', 'guard-id']),
    );
  });

  it('el reenvio offline es idempotente: mismo clientScanId no duplica ni re-cierra', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([PATROL])
      .mockResolvedValueOnce([{
        tag_id: 'tag-id', checkpoint_id: 'cp-1', checkpoint_name: 'Acceso',
        kind: 'normal', latitude: null, longitude: null,
        is_closing_point: false,
      }])
      .mockResolvedValueOnce([]) // ON CONFLICT DO NOTHING: ya existia
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-1', anomalies: [] }]);
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinPuertaGps(), sinEnvioInforme());

    await expect(service.registerScan('patrol-id', 'guard-id', dto())).resolves.toMatchObject({
      replay: true,
      patrol: { status: 'en_curso' },
      progress: { scanned: 1, expected: 2, pct: 50 },
    });
    // 4 queries: nunca intenta cerrar ni insertar de nuevo
    expect(manager.query).toHaveBeenCalledTimes(4);
  });

  it('re-escanear un punto ya marcado lo DICE, con la hora del primero', async () => {
    /*
     * No es el replay (mismo escaneo reenviado): es el guardia pasando otra vez
     * la etiqueta de un punto que ya marco. La fila nueva se conserva —marca,
     * no rechaza— pero antes el telefono no recibia ninguna señal y el guardia
     * repetia sin saber si el primero habia contado.
     */
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([PATROL])
      .mockResolvedValueOnce([{
        tag_id: 'tag-id', checkpoint_id: 'cp-1', checkpoint_name: 'Acceso',
        kind: 'normal', latitude: null, longitude: null, is_closing_point: false,
      }])
      .mockResolvedValueOnce([{ id: 'scan-2' }]) // el nuevo SI se inserta
      .mockResolvedValueOnce([
        {
          id: 'scan-1', checkpoint_id: 'cp-1',
          client_scan_id: 'otro-clientScanId-anterior',
          anomalies: [], scanned_at_server: new Date('2026-08-08T15:49:31.000Z'),
        },
        {
          id: 'scan-2', checkpoint_id: 'cp-1',
          client_scan_id: '3a0c8f7e-1111-4222-8333-444455556666',
          anomalies: [], scanned_at_server: new Date('2026-08-08T16:10:00.000Z'),
        },
      ]);
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinPuertaGps(), sinEnvioInforme());

    await expect(service.registerScan('patrol-id', 'guard-id', dto())).resolves.toMatchObject({
      replay: false,
      alreadyScanned: true,
      firstScannedAt: new Date('2026-08-08T15:49:31.000Z'),
    });
  });

  it('rechaza la etiqueta de un punto que no pertenece a la ronda', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([PATROL])
      .mockResolvedValueOnce([{
        tag_id: 'tag-x', checkpoint_id: 'cp-de-otro-recinto', checkpoint_name: 'Bodega ajena',
        kind: 'normal', latitude: null, longitude: null, is_closing_point: null,
      }]);
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinPuertaGps(), sinEnvioInforme());

    await expect(service.registerScan('patrol-id', 'guard-id', dto())).rejects.toThrow(
      'El punto escaneado no pertenece a esta ronda',
    );
  });

  it('cerrar bajo el umbral alerta al admin, directo (#64)', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([PATROL]) // la ronda
      .mockResolvedValueOnce([{
        tag_id: 'tag-id', checkpoint_id: 'cp-2', checkpoint_name: 'Porteria',
        kind: 'acceso_critico', latitude: null, longitude: null,
        is_closing_point: true,
      }])
      .mockResolvedValueOnce([{ id: 'scan-id' }]) // insert
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-2', anomalies: [] }]) // solo 1 de 2 -> 50%
      .mockResolvedValueOnce([]); // cierre
    const correo = sinCorreo();
    const envio = sinEnvioInforme();
    const service = new GuardService({ manager } as unknown as TenantContextService, correo, sinReglas(), sinEscalamiento(), sinPuertaGps(), envio);

    await expect(
      service.registerScan('patrol-id', 'guard-id', dto({ latitude: undefined, longitude: undefined })),
    ).resolves.toMatchObject({
      alertSent: true,
      // Al 50% la palabra dice la verdad: incompleta. Antes decia "completada"
      // incondicional, con la mitad de los puntos sin marcar.
      patrol: { status: 'incompleta', compliancePct: 50 },
    });

    // El requisito de #64 sigue en pie —la alerta va DIRECTO al admin— pero la
    // manda el carril de envio (#86), con el PDF adjunto y quedando en la
    // bitacora, en vez del texto plano que mandaba este servicio. Aca se prueba
    // que el cierre lo dispara; el contenido y los destinatarios se prueban en
    // envio-informe.service.spec.ts, que es donde vive esa decision.
    expect(envio.alCerrarRonda).toHaveBeenCalledWith('patrol-id');
    // Y ya no manda el aviso por su cuenta: dos correos por la misma ronda mala
    // fue justo lo que hubo que evitar al enganchar.
    expect(correo.enqueue).not.toHaveBeenCalled();
  });

  it('si el correo falla, el escaneo y el cierre NO se rompen', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([PATROL])
      .mockResolvedValueOnce([{
        tag_id: 'tag-id', checkpoint_id: 'cp-2', checkpoint_name: 'Porteria',
        kind: 'normal', latitude: null, longitude: null, is_closing_point: true,
      }])
      .mockResolvedValueOnce([{ id: 'scan-id' }])
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-2', anomalies: [] }])
      .mockResolvedValueOnce([]) // cierre
      .mockResolvedValueOnce([{
        tenant_id: 'tenant-1', site_name: 'Planta', route_name: 'Ruta', guard_name: 'Ana',
      }])
      .mockResolvedValueOnce([{ id: 'admin-1', email: 'admin@empresa.test' }]);
    const correo = { enqueue: jest.fn().mockRejectedValue(new Error('redis caido')) } as
      unknown as MailQueueService;
    const service = new GuardService({ manager } as unknown as TenantContextService, correo, sinReglas(), sinEscalamiento(), sinPuertaGps(), sinEnvioInforme());

    await expect(
      service.registerScan('patrol-id', 'guard-id', dto({ latitude: undefined, longitude: undefined })),
    ).resolves.toMatchObject({ patrol: { status: 'incompleta' } });
  });

  it('el boton de panico registra sin texto y delega el escalamiento (#123, #126)', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([{ id: 'patrol-id', site_id: 'site-id' }]) // ultima ronda
      .mockResolvedValueOnce([{ id: 'evento-id', reported_at_server: new Date() }]); // insert
    // Resolver destinatarios y armar el correo ya NO es tarea del guardia:
    // vive en EscalationService, que decide la cadena segun la regla del tenant.
    const escalamiento = sinEscalamiento(1);
    const correo = sinCorreo();
    const service = new GuardService(
      { manager } as unknown as TenantContextService,
      correo,
      sinReglas(),
      escalamiento,
      sinPuertaGps(), sinEnvioInforme(),
    );

    await expect(
      service.reportEvent('guard-id', {
        criticality: 'panico',
        clientEventId: '9a0c8f7e-1111-4222-8333-444455556666',
        latitude: -33.45, longitude: -70.66,
      }),
    ).resolves.toMatchObject({ replay: false, notified: true, criticality: 'panico' });
    expect(escalamiento.notify).toHaveBeenCalledWith(
      'evento-id',
      'panico',
      expect.objectContaining({ siteId: 'site-id', guardId: 'guard-id' }),
    );
    // El correo lo encola la cadena, no el flujo del guardia.
    expect(correo.enqueue).not.toHaveBeenCalled();
  });

  it('reenviar el mismo evento no duplica la fila NI re-avisa (#123)', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([{ id: 'patrol-id', site_id: 'site-id' }])
      .mockResolvedValueOnce([]) // ON CONFLICT: ya existia
      .mockResolvedValueOnce([{ id: 'evento-id' }]); // busqueda del original
    const correo = sinCorreo();
    const service = new GuardService({ manager } as unknown as TenantContextService, correo, sinReglas(), sinEscalamiento(), sinPuertaGps(), sinEnvioInforme());

    await expect(
      service.reportEvent('guard-id', {
        criticality: 'panico',
        clientEventId: '9a0c8f7e-1111-4222-8333-444455556666',
      }),
    ).resolves.toMatchObject({ replay: true, notified: false, id: 'evento-id' });
    expect(correo.enqueue).not.toHaveBeenCalled();
  });

  it('una novedad informativa no molesta a nadie por correo', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([{ id: 'patrol-id', site_id: 'site-id' }])
      .mockResolvedValueOnce([{ id: 'evento-id', reported_at_server: new Date() }]);
    const correo = sinCorreo();
    const service = new GuardService({ manager } as unknown as TenantContextService, correo, sinReglas(), sinEscalamiento(), sinPuertaGps(), sinEnvioInforme());

    await expect(
      service.reportEvent('guard-id', {
        criticality: 'info',
        text: 'Porton norte quedo con la luz quemada',
        clientEventId: '9a0c8f7e-1111-4222-8333-444455556666',
      }),
    ).resolves.toMatchObject({ replay: false, notified: false });
    expect(correo.enqueue).not.toHaveBeenCalled();
  });

  it('marca sin_fix_gps cuando no vienen coordenadas, pero registra igual', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([PATROL])
      .mockResolvedValueOnce([{
        tag_id: 'tag-id', checkpoint_id: 'cp-1', checkpoint_name: 'Acceso',
        kind: 'normal', latitude: '-33.45', longitude: '-70.66',
        is_closing_point: false,
      }])
      .mockResolvedValueOnce([{ id: 'scan-id' }])
      .mockResolvedValueOnce([{ checkpoint_id: 'cp-1', anomalies: ['sin_fix_gps'] }]);
    const service = new GuardService({ manager } as unknown as TenantContextService, sinCorreo(), sinReglas(), sinEscalamiento(), sinPuertaGps(), sinEnvioInforme());

    await expect(
      service.registerScan('patrol-id', 'guard-id', dto({ latitude: undefined, longitude: undefined })),
    ).resolves.toMatchObject({
      replay: false,
      anomalies: ['sin_fix_gps'],
      patrol: { status: 'en_curso' },
    });
  });

  it('marca como sospechoso un GPS a unos 500 m y un reloj manipulado', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([PATROL])
      .mockResolvedValueOnce([{
        tag_id: 'tag-id', checkpoint_id: 'cp-1', checkpoint_name: 'Acceso',
        kind: 'normal', latitude: '-33.45', longitude: '-70.66',
        is_closing_point: false,
      }])
      .mockResolvedValueOnce([{ id: 'scan-id' }])
      .mockResolvedValueOnce([{
        checkpoint_id: 'cp-1',
        anomalies: ['fuera_de_radio_gps', 'reloj_desfasado'],
      }]);
    const service = new GuardService(
      { manager } as unknown as TenantContextService,
      sinCorreo(), sinReglas(), sinEscalamiento(), sinPuertaGps(), sinEnvioInforme(),
    );

    await expect(service.registerScan('patrol-id', 'guard-id', dto({
      latitude: -33.4455,
      scannedAt: '2020-01-01T00:00:00.000Z',
    }))).resolves.toMatchObject({
      anomalies: ['fuera_de_radio_gps', 'reloj_desfasado'],
    });
    const insert = manager.query.mock.calls.find(([sql]: [string]) =>
      sql.includes('INSERT INTO scans'));
    expect(insert?.[1][10]).toContain('fuera_de_radio_gps');
    expect(insert?.[1][10]).toContain('reloj_desfasado');
  });
});

/* ------------------------------------------------------------------ *
 * La foto obligatoria del punto critico
 *
 * CLAUDE.md: "En los accesos criticos ademas debe fotografiar el estado de la
 * puerta". El JSON de puntos no mandaba `kind` ni `requiresPhoto`, asi que la
 * pantalla de terreno no tenia con que saberlo y nunca se la pedia al guardia.
 * ------------------------------------------------------------------ */

/** EvidenceService de mentira: resuelve horario y foto sin base ni disco. */
const sinEvidencia = (opciones: { enHorario?: boolean; exigeFoto?: boolean } = {}) =>
  ({
    isWithinBusinessHours: jest.fn().mockResolvedValue(opciones.enHorario ?? true),
    requiresPhoto: jest.fn().mockResolvedValue({
      required: opciones.exigeFoto ?? false,
      withinBusinessHours: opciones.enHorario ?? true,
      checkpoint: { id: 'cp-1', kind: 'normal', requiresPhoto: null },
    }),
  }) as unknown as EvidenceService;

const conEvidencia = (
  manager: { query: jest.Mock },
  evidencia: EvidenceService = sinEvidencia(),
) =>
  new GuardService(
    { manager } as unknown as TenantContextService,
    sinCorreo(), sinReglas(), sinEscalamiento(), sinPuertaGps(), sinEnvioInforme(),
    undefined, evidencia,
  );

/** Fila de ronda completa, para los casos que llegan hasta la respuesta. */
const RONDA = {
  id: 'patrol-id',
  status: 'en_curso' as const,
  site_id: 'site-id',
  scheduled_start_at: new Date('2026-08-04T22:00:00-04:00'),
  scheduled_end_at: new Date('2026-08-05T06:00:00-04:00'),
  started_at: null,
  site_name: 'Recinto',
  site_timezone: 'America/Santiago',
  route_name: 'Ronda nocturna',
  estimated_duration_min: 30,
  checkpoints: [],
};

describe('GuardService.getHome — foto obligatoria del punto', () => {
  /**
   * Un mock devuelve lo que le pidas y no sabe SQL. Los nombres de columna se
   * comprueban contra la MIGRACION, que es la unica fuente de verdad: asi es
   * como llego a produccion un SELECT de una columna que no existe, con la CI
   * en verde y el mock devolviendo la columna inventada.
   */
  it('las columnas de checkpoints que pide existen en la migracion', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    await conEvidencia(manager).getHome('guard-id');

    const sql = (manager.query.mock.calls[0]?.[0] as string).replace(/--.*$/gm, '');
    const migracion = readFileSync(
      join(__dirname, '../database/migrations/1722524400000-CreateDemoDomain.ts'),
      'utf8',
    );
    const cuerpo = /CREATE TABLE checkpoints \(([\s\S]*?)\n {6}\)/.exec(migracion)?.[1] ?? '';
    const columnas = new Set(
      cuerpo
        .split('\n')
        .map((linea) => /^ {8}([a-z_]+) /.exec(linea)?.[1])
        .filter((nombre): nombre is string => Boolean(nombre)),
    );

    // La migracion se leyo de verdad: si el regex fallara, el resto de este
    // test pasaria sin comprobar nada.
    expect(columnas.has('kind')).toBe(true);
    expect(columnas.has('requires_photo')).toBe(true);

    const pedidas = new Set(
      Array.from(sql.matchAll(/\bc\.([a-z_]+)/g), (coincidencia) => coincidencia[1] as string),
    );
    expect(pedidas.has('kind')).toBe(true);
    expect(pedidas.has('requires_photo')).toBe(true);
    for (const columna of pedidas) expect(Array.from(columnas)).toContain(columna);
  });

  it('cada punto viaja con su criticidad y su override de foto', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };
    await conEvidencia(manager).getHome('guard-id');

    const sql = (manager.query.mock.calls[0]?.[0] as string).replace(/--.*$/gm, '');
    // Las CLAVES del jsonb son el contrato con el telefono: si se renombran, el
    // punto llega sin criticidad y la foto deja de pedirse en silencio.
    expect(sql).toContain("'kind', c.kind");
    expect(sql).toContain("'requiresPhoto', c.requires_photo");
  });

  it('manda el horario del recinto y las reglas con que el telefono decide', async () => {
    const manager = { query: jest.fn().mockResolvedValue([RONDA]) };
    const evidencia = sinEvidencia({ enHorario: false });

    const home = await conEvidencia(manager, evidencia).getHome('guard-id');

    expect(home).toMatchObject({
      photoPolicy: {
        withinBusinessHours: false,
        rules: { photoRequiredOutsideHours: true, photoRequiredOnCritical: true },
      },
    });
    // El horario es el DEL RECINTO de esta ronda, no uno cualquiera.
    expect(evidencia.isWithinBusinessHours).toHaveBeenCalledWith('site-id');
  });

  it('si el horario no se puede resolver, la pantalla del turno igual carga', async () => {
    const manager = { query: jest.fn().mockResolvedValue([RONDA]) };
    const evidencia = {
      isWithinBusinessHours: jest.fn().mockRejectedValue(new Error('el recinto no existe')),
      requiresPhoto: jest.fn(),
    } as unknown as EvidenceService;

    const home = await conEvidencia(manager, evidencia).getHome('guard-id');

    expect(home).toMatchObject({ hasAssignment: true });
    // Se omite en vez de inventar un horario: el telefono cae en su respaldo.
    expect(home).not.toHaveProperty('photoPolicy');
  });
});

describe('GuardService.registerScan — id del escaneo y foto del punto', () => {
  const RONDA_ESCANEO = {
    id: 'patrol-id',
    status: 'en_curso',
    route_id: 'route-id',
    expected_checkpoint_ids: ['cp-1'],
    site_id: 'site-id',
    started_at: new Date(Date.now() - 30 * 60_000),
    scheduled_end_at: new Date(Date.now() + 6 * 3_600_000),
    closed_at: null,
  };
  const CLIENT_SCAN_ID = '3a0c8f7e-1111-4222-8333-444455556666';
  const entrada = () => ({
    uid: 'ABCD1234',
    method: 'nfc' as const,
    clientScanId: CLIENT_SCAN_ID,
    latitude: -33.45,
    longitude: -70.66,
  });
  const PUNTO_CRITICO = {
    tag_id: 'tag-id', checkpoint_id: 'cp-1', checkpoint_name: 'Porteria',
    kind: 'acceso_critico', latitude: '-33.45', longitude: '-70.66',
    is_closing_point: false,
  };
  const escaneoDeLaRonda = (id: string) => ({
    id, checkpoint_id: 'cp-1', client_scan_id: CLIENT_SCAN_ID, anomalies: [],
  });

  it('devuelve el id del escaneo: sin el, la foto no tiene donde colgarse', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([RONDA_ESCANEO])
      .mockResolvedValueOnce([PUNTO_CRITICO])
      .mockResolvedValueOnce([{ id: 'scan-nuevo' }])
      .mockResolvedValueOnce([escaneoDeLaRonda('scan-nuevo')]);

    await expect(
      conEvidencia(manager, sinEvidencia({ exigeFoto: true })).registerScan(
        'patrol-id', 'guard-id', entrada(),
      ),
    ).resolves.toMatchObject({
      scanId: 'scan-nuevo',
      checkpoint: { kind: 'acceso_critico', photoRequired: true },
    });
  });

  it('en el reenvio el id sale de la consulta que ya se hacia, sin viaje extra', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([RONDA_ESCANEO])
      .mockResolvedValueOnce([PUNTO_CRITICO])
      .mockResolvedValueOnce([]) // ON CONFLICT DO NOTHING: ya existia
      .mockResolvedValueOnce([escaneoDeLaRonda('scan-original')]);

    await expect(
      conEvidencia(manager).registerScan('patrol-id', 'guard-id', entrada()),
    ).resolves.toMatchObject({ replay: true, scanId: 'scan-original' });
    // Las mismas 4 consultas de antes: el id no cuesta un viaje mas a la base.
    expect(manager.query).toHaveBeenCalledTimes(4);
  });

  it('un fallo resolviendo la foto no tumba el escaneo, solo lo deja sin veredicto', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([RONDA_ESCANEO])
      .mockResolvedValueOnce([PUNTO_CRITICO])
      .mockResolvedValueOnce([{ id: 'scan-nuevo' }])
      .mockResolvedValueOnce([escaneoDeLaRonda('scan-nuevo')]);
    const evidencia = {
      isWithinBusinessHours: jest.fn(),
      requiresPhoto: jest.fn().mockRejectedValue(new Error('sin horario')),
    } as unknown as EvidenceService;

    await expect(
      conEvidencia(manager, evidencia).registerScan('patrol-id', 'guard-id', entrada()),
    ).resolves.toMatchObject({
      replay: false,
      // null y no false: "no lo se" no es "no hace falta". El telefono decide
      // entonces con la politica que le llego en /guard/home.
      checkpoint: { photoRequired: null },
    });
  });

  it('sin EvidenceService inyectado responde null y no revienta', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([RONDA_ESCANEO])
      .mockResolvedValueOnce([PUNTO_CRITICO])
      .mockResolvedValueOnce([{ id: 'scan-nuevo' }])
      .mockResolvedValueOnce([escaneoDeLaRonda('scan-nuevo')]);
    const service = new GuardService(
      { manager } as unknown as TenantContextService,
      sinCorreo(), sinReglas(), sinEscalamiento(), sinPuertaGps(), sinEnvioInforme(),
    );

    await expect(service.registerScan('patrol-id', 'guard-id', entrada())).resolves.toMatchObject({
      checkpoint: { photoRequired: null },
    });
  });
});
