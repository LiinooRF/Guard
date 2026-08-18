import type { AuditService } from '../audit/audit.service';
import type { AuthService } from '../auth/auth.service';
import type { MailService } from '../auth/mail.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { AdminService } from './admin.service';

const service = (query: jest.Mock) => new AdminService(
  { manager: { query } } as unknown as TenantContextService,
  { revokeAllSessions: jest.fn() } as unknown as AuthService,
  {} as MailService,
  { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
);

describe('AdminService catálogo de recintos (#101)', () => {
  it('reemplaza el horario sólo del recinto seleccionado', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'site-1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'site-1' }])
      .mockResolvedValueOnce([{ weekday: 1, opens_at: '09:00', closes_at: '18:00' }]);

    const result = await service(query).replaceBusinessHours('site-1', [
      { weekday: 1, opensAt: '09:00', closesAt: '18:00' },
    ]);
    expect(result).toEqual([{ weekday: 1, opensAt: '09:00', closesAt: '18:00' }]);
    expect(query.mock.calls[1]?.[1]).toEqual(['site-1']);
    expect(query.mock.calls[2]?.[1]).toEqual(['site-1', 1, '09:00', '18:00']);
  });

  it('rechaza dos horarios para el mismo día antes de borrar el vigente', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ id: 'site-1' }]);
    await expect(service(query).replaceBusinessHours('site-1', [
      { weekday: 1, opensAt: '09:00', closesAt: '18:00' },
      { weekday: 1, opensAt: '20:00', closesAt: '23:00' },
    ])).rejects.toThrow('Cada día puede tener un solo horario');
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('valida fechas reales y duplicados antes de reemplazar feriados', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 'site-1' }]);
    await expect(service(query).replaceHolidays('site-1', [
      { date: '2026-02-30', name: 'Fecha imposible' },
    ])).rejects.toThrow('no es válida');
    await expect(service(query).replaceHolidays('site-1', [
      { date: '2026-09-18' }, { date: '2026-09-18' },
    ])).rejects.toThrow('una sola vez');
  });

  it('importa 30 puntos y sus etiquetas dentro del request tenant', async () => {
    const query = jest.fn().mockResolvedValue([]);
    query.mockResolvedValueOnce([{ id: 'site-1' }]);
    const rows = Array.from({ length: 30 }, (_, index) => ({
      name: `Punto ${index + 1}`,
      suggestedOrder: index + 1,
      tagUid: `NFC-${index + 1}`,
    }));
    const result = await service(query).importCheckpoints('site-1', rows);
    expect(result.imported).toBe(30);
    const pointCalls = query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO checkpoints'));
    expect(pointCalls).toHaveLength(30);
    expect(query.mock.calls.filter(([sql]) => String(sql).includes('INSERT INTO tags'))).toHaveLength(30);
    for (const [, params] of pointCalls) expect(params).toContain('site-1');
  });

  it('rechaza UID repetido antes de crear el primer punto', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ id: 'site-1' }]);
    await expect(service(query).importCheckpoints('site-1', [
      { name: 'Uno', tagUid: 'ABCD' },
      { name: 'Dos', tagUid: 'abcd' },
    ])).rejects.toThrow('repite una etiqueta NFC');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
