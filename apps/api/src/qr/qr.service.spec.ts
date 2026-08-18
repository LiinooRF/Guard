import { patrolRulesSchema } from '@sentrycore/shared';
import { QueryFailedError } from 'typeorm';

import { QrService } from './qr.service';
import type { AuditService } from '../audit/audit.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';

const reglas = (allowQrFallback = true) =>
  ({
    effective: jest
      .fn()
      .mockResolvedValue({ ...patrolRulesSchema.parse({}), allowQrFallback }),
  }) as unknown as RulesService;

const auditoria = () =>
  ({ record: jest.fn().mockResolvedValue(undefined) }) as unknown as AuditService;

const servicio = (
  query: jest.Mock,
  rules: RulesService = reglas(),
  audit: AuditService = auditoria(),
) => new QrService({ manager: { query } } as unknown as TenantContextService, rules, audit);

const PUNTO = {
  id: 'cp-1',
  name: 'Portería principal',
  is_active: true,
  site_id: 'site-1',
  site_name: 'Planta Norte',
};

const RECINTO = {
  id: 'site-1',
  name: 'Planta Norte',
  branch_name: 'Norte',
  timezone: 'America/Santiago',
  tenant_name: 'Seguridad Andes',
};

const EMITIDA = new Date('2026-08-03T12:00:00Z');

/** Devuelve la fila que el INSERT habria escrito, con el UID recien generado. */
const insertaDevolviendoUid = () =>
  jest.fn(async (_sql: string, params: string[]) => [
    { id: 'tag-nuevo', uid: params[2]!, installed_at: EMITIDA },
  ]);

const conflictoUnico = () =>
  new QueryFailedError(
    'INSERT INTO tags',
    [],
    Object.assign(new Error('duplicate key'), { code: '23505' }),
  );

const sql = (llamadas: jest.Mock, fragmento: string) =>
  llamadas.mock.calls.some(([texto]: [string]) => texto.includes(fragmento));

describe('QrService.issueForCheckpoint — #56', () => {
  const emisionLimpia = () =>
    jest
      .fn()
      .mockResolvedValueOnce([PUNTO]) // el punto existe y esta activo
      .mockResolvedValueOnce([]) // no hay QR vigente
      .mockImplementationOnce(insertaDevolviendoUid())
      .mockResolvedValueOnce([{ label: 'Ana Admin' }]); // actor para la auditoria

  it('el UID es aleatorio con prefijo reconocible, no derivado del punto', async () => {
    const primera = await servicio(emisionLimpia()).issueForCheckpoint('cp-1', 'admin-1');
    const segunda = await servicio(emisionLimpia()).issueForCheckpoint('cp-1', 'admin-1');

    expect(primera.uid).toMatch(/^VXQ-[A-Z2-7]{26}$/);
    // Mismo punto, dos emisiones: si el UID se derivara del id serian iguales y
    // cualquiera con el id imprimiria el QR de un punto ajeno.
    expect(primera.uid).not.toBe(segunda.uid);
    expect(primera.uid).not.toContain('cp-1');
    expect(primera.created).toBe(true);
    expect(primera.svg).toContain('<svg');
  });

  it('el UID cabe en la restriccion de largo de tags (4..64)', async () => {
    const { uid } = await servicio(emisionLimpia()).issueForCheckpoint('cp-1', 'admin-1');
    expect(uid.length).toBe(30);
  });

  it('re-emitir devuelve la etiqueta vigente en vez de duplicarla', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([PUNTO])
      .mockResolvedValueOnce([
        { id: 'tag-1', uid: 'VXQ-AAAAAAAAAAAAAAAAAAAAAAAAAA', installed_at: EMITIDA },
      ]);

    await expect(servicio(query).issueForCheckpoint('cp-1', 'admin-1')).resolves.toMatchObject({
      tagId: 'tag-1',
      uid: 'VXQ-AAAAAAAAAAAAAAAAAAAAAAAAAA',
      created: false,
    });
    expect(sql(query, 'INSERT INTO tags')).toBe(false);
  });

  it('la carrera contra el indice del punto devuelve la etiqueta que gano', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([PUNTO])
      .mockResolvedValueOnce([]) // el pre-chequeo no la vio
      .mockRejectedValueOnce(conflictoUnico())
      .mockResolvedValueOnce([
        { id: 'tag-ganadora', uid: 'VXQ-BBBBBBBBBBBBBBBBBBBBBBBBBB', installed_at: EMITIDA },
      ]);

    await expect(servicio(query).issueForCheckpoint('cp-1', 'admin-1')).resolves.toMatchObject({
      tagId: 'tag-ganadora',
      created: false,
    });
  });

  it('la emision queda en la auditoria del tenant', async () => {
    const audit = auditoria();
    await servicio(emisionLimpia(), reglas(), audit).issueForCheckpoint('cp-1', 'admin-1');

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: 'admin-1',
        actorLabel: 'Ana Admin',
        action: 'etiqueta.registrada',
        entityType: 'tag',
        entityId: 'tag-nuevo',
      }),
    );
  });

  it('la regla del tenant manda: sin respaldo QR no se emite ni se toca la base', async () => {
    const query = jest.fn();

    await expect(
      servicio(query, reglas(false)).issueForCheckpoint('cp-1', 'admin-1'),
    ).rejects.toThrow('respaldo por QR está deshabilitado');
    expect(query).not.toHaveBeenCalled();
  });

  it('un punto desactivado no recibe etiqueta', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ ...PUNTO, is_active: false }]);

    await expect(servicio(query).issueForCheckpoint('cp-1', 'admin-1')).rejects.toThrow(
      'El punto de control está desactivado',
    );
    expect(sql(query, 'INSERT INTO tags')).toBe(false);
  });

  it('un punto de otro tenant no existe: RLS lo deja fuera y responde 404', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);

    await expect(servicio(query).issueForCheckpoint('cp-ajeno', 'admin-1')).rejects.toThrow(
      'Punto de control no encontrado',
    );
  });
});

describe('QrService.sheetForSite — #135', () => {
  const puntos = [
    { id: 'cp-1', name: 'Portería', kind: 'normal', uid: 'VXQ-CCCCCCCCCCCCCCCCCCCCCCCCCC', installed_at: EMITIDA },
    { id: 'cp-2', name: 'Bodega', kind: 'acceso_critico', uid: null, installed_at: null },
    { id: 'cp-3', name: 'Patio', kind: 'normal', uid: 'VXQ-DDDDDDDDDDDDDDDDDDDDDDDDDD', installed_at: EMITIDA },
  ];

  const planilla = () =>
    jest.fn().mockResolvedValueOnce([RECINTO]).mockResolvedValueOnce(puntos);

  it('incluye TODOS los puntos activos del recinto, tengan etiqueta o no', async () => {
    const query = planilla();
    const resultado = await servicio(query).sheetForSite('site-1');

    expect(resultado.labels).toHaveLength(3);
    expect(resultado.labels.map((label) => label.checkpointId)).toEqual(['cp-1', 'cp-2', 'cp-3']);
    expect(resultado.issued).toBe(2);
    expect(resultado.missing).toBe(1);
    // La consulta filtra los puntos desactivados en SQL, no en memoria.
    expect(sql(query, 'punto.is_active')).toBe(true);
  });

  it('el punto sin etiqueta viaja marcado, no se emite una al vuelo', async () => {
    const query = planilla();
    const resultado = await servicio(query).sheetForSite('site-1');

    expect(resultado.labels[1]).toMatchObject({ checkpointId: 'cp-2', uid: null, svg: null });
    expect(sql(query, 'INSERT INTO tags')).toBe(false);
  });

  it('cada etiqueta trae su SVG y el sufijo corto para el instalador', async () => {
    const resultado = await servicio(planilla()).sheetForSite('site-1');

    expect(resultado.labels[0]?.svg).toContain('<path fill="#000000"');
    expect(resultado.labels[0]?.shortCode).toBe('CCCCCC');
    expect(resultado.qrBackupEnabled).toBe(true);
  });

  it('un recinto que no existe responde 404', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);

    await expect(servicio(query).sheetForSite('site-x')).rejects.toThrow('Recinto no encontrado');
  });

  it('la planilla en PDF sale de los mismos datos', async () => {
    const resultado = await servicio(planilla()).sheetPdf('site-1');

    expect(resultado.pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(resultado.filename).toBe('etiquetas-qr-site-1.pdf');
    expect(resultado.labels).toBe(3);
    expect(resultado.missing).toBe(1);
  });

  it('un recinto sin puntos activos igual entrega un PDF, no un error', async () => {
    const query = jest.fn().mockResolvedValueOnce([RECINTO]).mockResolvedValueOnce([]);
    const resultado = await servicio(query).sheetPdf('site-1');

    expect(resultado.pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
    expect(resultado.labels).toBe(0);
  });
});
