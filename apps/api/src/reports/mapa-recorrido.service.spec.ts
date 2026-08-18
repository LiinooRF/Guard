import { ForbiddenException } from '@nestjs/common';
import { patrolRulesSchema } from '@sentrycore/shared';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';
import type { SupervisorService } from '../supervisor/supervisor.service';
import { MapaRecorridoService } from './mapa-recorrido.service';
import type { FilaPunto } from './patrol-report.model';

/**
 * Consultas, reglas y alcance del SUPERVISOR. El dibujo se prueba aparte.
 *
 * El manager falso responde por el CONTENIDO del SQL y no por el orden de las
 * llamadas, igual que en patrol-report.service.spec: asi un test no se rompe
 * porque se agrego una consulta antes.
 *
 * Todas las consultas de este servicio son SELECT, y un SELECT del driver de
 * postgres devuelve un arreglo de filas. Los mocks devuelven eso mismo: si
 * alguna vez aparece un UPDATE aca, hay que recordar que ese devuelve
 * [filas, rowCount] y no un arreglo plano.
 */

const RONDA = {
  site_id: 'site-1',
  site_latitude: '-33.450000',
  site_longitude: '-70.660000',
};

const punto = (numero: number, omitido = false): FilaPunto => ({
  numero,
  checkpointId: `cp-${numero}`,
  nombre: `Punto ${numero}`,
  esCierre: false,
  esCritico: false,
  omitido,
  escaneadoEn: omitido ? null : new Date('2026-07-30T23:00:00-04:00'),
  metodo: omitido ? null : 'nfc',
  anomalias: [],
  instrucciones: null,
});

const PUNTOS: FilaPunto[] = [punto(1), punto(2, true)];

interface Fixture {
  ronda?: unknown[];
  coordenadas?: unknown[];
  traza?: unknown[];
  escaneos?: unknown[];
}

function fakeManager(fixture: Fixture) {
  return {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('FROM patrols p')) return fixture.ronda ?? [RONDA];
      if (sql.includes('FROM checkpoints')) return fixture.coordenadas ?? [];
      if (sql.includes('FROM patrol_tracks')) return fixture.traza ?? [];
      if (sql.includes('FROM scans')) return fixture.escaneos ?? [];
      throw new Error(`consulta no esperada: ${sql}`);
    }),
  };
}

function armarServicio(
  fixture: Fixture = {},
  extras: { reglas?: Record<string, unknown>; asignado?: boolean } = {},
) {
  const manager = fakeManager(fixture);
  const rules = {
    effective: jest.fn().mockResolvedValue(patrolRulesSchema.parse(extras.reglas ?? {})),
  } as unknown as RulesService;
  const supervisor = {
    ensureAssignedSite:
      extras.asignado === false
        ? jest.fn().mockRejectedValue(new ForbiddenException('No tienes este recinto asignado'))
        : jest.fn().mockResolvedValue(undefined),
  } as unknown as SupervisorService;

  const service = new MapaRecorridoService(
    { manager } as unknown as TenantContextService,
    rules,
    supervisor,
  );
  return { service, manager, rules, supervisor };
}

const consulto = (manager: ReturnType<typeof fakeManager>, texto: string) =>
  manager.query.mock.calls.some(([sql]) => String(sql).includes(texto));

describe('MapaRecorridoService.construir', () => {
  it('arma el mapa con los puntos que llegan del informe', async () => {
    const { service } = armarServicio({
      coordenadas: [
        { id: 'cp-1', latitude: '-33.450000', longitude: '-70.660000' },
        { id: 'cp-2', latitude: '-33.449500', longitude: '-70.659600' },
      ],
      traza: [
        {
          recorded_at_device: new Date('2026-07-30T23:05:00-04:00'),
          latitude: '-33.450100',
          longitude: '-70.660100',
          accuracy_m: '9.00',
        },
      ],
    });

    const mapa = await service.construir('patrol-id', PUNTOS);

    expect(mapa).not.toBeNull();
    expect(mapa!.hayDatos).toBe(true);
    // El estado viene del informe, no de un recuento propio.
    expect(mapa!.puntos.map((p) => [p.numero, p.omitido])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(mapa!.traza).toHaveLength(1);
  });

  it('la ronda inexistente lanza NotFound sin consultar nada más', async () => {
    const { service, manager } = armarServicio({ ronda: [] });

    await expect(service.construir('patrol-fantasma', PUNTOS)).rejects.toThrow(
      'La ronda no existe',
    );
    expect(manager.query).toHaveBeenCalledTimes(1);
  });

  it('devuelve null cuando el tenant apagó el mapa en el informe', async () => {
    // null y "mapa vacio" son cosas distintas: null es que el cliente no quiere
    // la seccion, y por eso no se paga ni una consulta mas.
    const { service, manager } = armarServicio({}, { reglas: { reportIncludeMap: false } });

    const mapa = await service.construir('patrol-id', PUNTOS);

    expect(mapa).toBeNull();
    expect(consulto(manager, 'FROM patrol_tracks')).toBe(false);
    expect(consulto(manager, 'FROM checkpoints')).toBe(false);
  });

  it('resuelve las reglas en el recinto de la ronda, no las del tenant a secas', async () => {
    // Un tenant puede querer el mapa en sus condominios y no en la planta.
    const { service, rules } = armarServicio();

    await service.construir('patrol-id', PUNTOS);

    expect(rules.effective).toHaveBeenCalledWith({ siteId: 'site-1' });
  });

  it('sin puntos esperados no consulta coordenadas', async () => {
    const { service, manager } = armarServicio();

    await service.construir('patrol-id', []);

    expect(consulto(manager, 'FROM checkpoints')).toBe(false);
  });

  it('usa el máximo de error GPS configurado por el tenant', async () => {
    const { service } = armarServicio(
      {
        coordenadas: [{ id: 'cp-1', latitude: '-33.450000', longitude: '-70.660000' }],
        traza: [
          {
            recorded_at_device: new Date('2026-07-30T23:05:00-04:00'),
            latitude: '-33.450100',
            longitude: '-70.660100',
            accuracy_m: '400.00',
          },
        ],
      },
      { reglas: { mapTrackMaxAccuracyM: 30 } },
    );

    const mapa = await service.construir('patrol-id', PUNTOS);

    expect(mapa!.traza).toEqual([]);
    expect(mapa!.trazaDescartadaPorError).toBe(1);
  });
});

describe('MapaRecorridoService · alcance del SUPERVISOR', () => {
  const supervisor = { sub: 'sup-1', role: 'SUPERVISOR' as const };

  it('un SUPERVISOR sin el recinto asignado recibe 403 aunque tenga reports:read', async () => {
    const { service, manager } = armarServicio({}, { asignado: false });

    await expect(
      service.construir('patrol-id', PUNTOS, { requester: supervisor }),
    ).rejects.toThrow('No tienes este recinto asignado');
    // Se corta antes de leer una sola posición del guardia.
    expect(consulto(manager, 'FROM patrol_tracks')).toBe(false);
  });

  it('el recinto que se verifica es el de la ronda, no uno que mande el llamador', async () => {
    const { service, supervisor: servicioSupervisor } = armarServicio();

    await service.construir('patrol-id', PUNTOS, { requester: supervisor });

    expect(servicioSupervisor.ensureAssignedSite).toHaveBeenCalledWith('site-1', 'sup-1');
  });

  it('el ADMIN no gatilla la verificación por recinto', async () => {
    const { service, supervisor: servicioSupervisor } = armarServicio();

    await service.construir('patrol-id', PUNTOS, {
      requester: { sub: 'adm-1', role: 'ADMIN' },
    });

    expect(servicioSupervisor.ensureAssignedSite).not.toHaveBeenCalled();
  });

  it('sin requester (la cola del envío automático) tampoco la gatilla', async () => {
    const { service, supervisor: servicioSupervisor } = armarServicio();

    await service.construir('patrol-id', PUNTOS, { requester: null });

    expect(servicioSupervisor.ensureAssignedSite).not.toHaveBeenCalled();
  });
});
