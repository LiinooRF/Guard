import { ForbiddenException, type MessageEvent } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import {
  EventsStreamService,
  HEARTBEAT_MS,
  STREAM_TTL_MS,
  type NovedadStreamEvent,
} from './events-stream.service';

const NOVEDAD: NovedadStreamEvent = {
  type: 'novedad',
  siteId: 'site-1',
  eventId: 'ev-1',
  criticality: 'panico',
  patrolId: 'patrol-1',
  reportedAt: '2026-08-03T12:00:00.000Z',
};

function servicio(query: jest.Mock = jest.fn().mockResolvedValue([])) {
  const runner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager: { query },
  };
  const dataSource = {
    createQueryRunner: jest.fn().mockReturnValue(runner),
  } as unknown as DataSource;

  return { service: new EventsStreamService(dataSource), runner, query };
}

describe('EventsStreamService — emisor en memoria (#128)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('el suscriptor recibe el saludo inicial y despues los eventos de su recinto', () => {
    const { service } = servicio();
    const recibidos: MessageEvent[] = [];
    const suscripcion = service.streamForSite('t-1', 'site-1').subscribe((m) => recibidos.push(m));

    service.publish('t-1', NOVEDAD);

    expect(recibidos.map((m) => m.type)).toEqual(['ready', 'novedad']);
    // El retry deja explicito cada cuanto reintenta el navegador tras un corte.
    expect(recibidos[0]?.retry).toBeGreaterThan(0);
    expect(recibidos[1]?.data).toEqual(NOVEDAD);
    suscripcion.unsubscribe();
  });

  it('un evento de OTRO recinto de la misma empresa no llega', () => {
    const { service } = servicio();
    const recibidos: MessageEvent[] = [];
    const suscripcion = service.streamForSite('t-1', 'site-1').subscribe((m) => recibidos.push(m));

    service.publish('t-1', { ...NOVEDAD, siteId: 'site-2' });

    expect(recibidos.map((m) => m.type)).toEqual(['ready']);
    suscripcion.unsubscribe();
  });

  it('un evento de OTRA empresa no cruza de canal', () => {
    const { service } = servicio();
    const recibidos: MessageEvent[] = [];
    const suscripcion = service.streamForSite('t-1', 'site-1').subscribe((m) => recibidos.push(m));

    service.publish('t-2', NOVEDAD);

    expect(recibidos.map((m) => m.type)).toEqual(['ready']);
    suscripcion.unsubscribe();
  });

  it('publicar sin nadie conectado no revienta ni deja canales colgando', () => {
    const { service } = servicio();

    expect(() => service.publish('t-1', NOVEDAD)).not.toThrow();
    expect(service.activeChannels()).toBe(0);
  });

  it('el canal se libera cuando se va el ultimo suscriptor', () => {
    const { service } = servicio();
    const uno = service.streamForSite('t-1', 'site-1').subscribe();
    const dos = service.streamForSite('t-1', 'site-2').subscribe();
    expect(service.activeChannels()).toBe(1);

    uno.unsubscribe();
    expect(service.activeChannels()).toBe(1);

    dos.unsubscribe();
    expect(service.activeChannels()).toBe(0);
  });

  it('manda un latido periodico: sin trafico el proxy corta la conexion ociosa', () => {
    const { service } = servicio();
    const recibidos: MessageEvent[] = [];
    const suscripcion = service.streamForSite('t-1', 'site-1').subscribe((m) => recibidos.push(m));

    jest.advanceTimersByTime(HEARTBEAT_MS);
    expect(recibidos.map((m) => m.type)).toEqual(['ready', 'ping']);

    jest.advanceTimersByTime(HEARTBEAT_MS);
    expect(recibidos.filter((m) => m.type === 'ping')).toHaveLength(2);
    suscripcion.unsubscribe();
  });

  it('la conexion se corta al vencer su tope y el canal queda liberado', () => {
    const { service } = servicio();
    const completado = jest.fn();
    service.streamForSite('t-1', 'site-1').subscribe({ complete: completado });

    jest.advanceTimersByTime(STREAM_TTL_MS);

    expect(completado).toHaveBeenCalled();
    expect(service.activeChannels()).toBe(0);
  });
});

describe('EventsStreamService — alcance por recinto (#128)', () => {
  it('sin el recinto asignado responde 403', async () => {
    const query = jest.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const { service, runner } = servicio(query);

    await expect(service.ensureAssignedSite('t-1', 'sup-1', 'site-1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(runner.commitTransaction).toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalled();
  });

  it('con el recinto asignado pasa y fija el tenant DENTRO de la transaccion', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ present: true }]);
    const { service, runner } = servicio(query);

    await expect(service.ensureAssignedSite('t-1', 'sup-1', 'site-1')).resolves.toBeUndefined();

    const [sqlContexto, parametros] = query.mock.calls[0] as [string, unknown[]];
    expect(sqlContexto).toContain(`set_config('app.tenant_id', $1, true)`);
    expect(parametros).toEqual(['t-1', 'sup-1']);
    expect(runner.startTransaction).toHaveBeenCalled();
    // La conexion vuelve al pool ANTES de que empiece el streaming.
    expect(runner.release).toHaveBeenCalled();
  });

  it('si la consulta falla revierte y suelta la conexion igual', async () => {
    const query = jest.fn().mockRejectedValueOnce(new Error('conexion caida'));
    const { service, runner } = servicio(query);

    await expect(service.ensureAssignedSite('t-1', 'sup-1', 'site-1')).rejects.toThrow(
      'conexion caida',
    );
    expect(runner.rollbackTransaction).toHaveBeenCalled();
    expect(runner.release).toHaveBeenCalled();
  });
});
