import type { ConfigService } from '@nestjs/config';
import { patrolRulesSchema, type PatrolRules } from '@sentrycore/shared';

import { EvidenceService, type FotoSubida } from './evidence.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { PatrolReportService } from '../reports/patrol-report.service';
import type { RulesService } from '../rules/rules.service';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  rm: jest.fn().mockResolvedValue(undefined),
}));

import { mkdir, rm, writeFile } from 'node:fs/promises';

/** Motor de reglas sin overrides: responde los defaults del producto (#16). */
const reglas = (overrides: Partial<PatrolRules> = {}) =>
  ({
    effective: jest.fn().mockResolvedValue({ ...patrolRulesSchema.parse({}), ...overrides }),
  }) as unknown as RulesService;

const servicio = (
  manager: { query: jest.Mock },
  rules: RulesService = reglas(),
  patrolReport?: { invalidarCache: jest.Mock },
) =>
  new EvidenceService(
    { manager } as unknown as TenantContextService,
    rules,
    { getOrThrow: jest.fn().mockReturnValue('/evidencia') } as unknown as ConfigService,
    patrolReport as unknown as PatrolReportService,
  );

/** PNG minimo valido: firma + IHDR con 640x480. */
const fotoPng = (): FotoSubida => {
  const buffer = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(640, 16);
  buffer.writeUInt32BE(480, 20);
  return { mimetype: 'image/png', size: buffer.length, buffer };
};

const ESCANEO = {
  id: 'scan-id',
  tenant_id: 'tenant-1',
  patrol_id: 'patrol-1',
  checkpoint_id: 'cp-1',
  patrol_status: 'en_curso',
};

beforeEach(() => jest.clearAllMocks());

describe('EvidenceService.isWithinBusinessHours', () => {
  it('dentro del horario definido del recinto', async () => {
    const manager = { query: jest.fn().mockResolvedValue([{ has_hours: true, within: true }]) };
    const rules = reglas();

    await expect(
      servicio(manager, rules).isWithinBusinessHours('site-id', new Date('2026-08-03T15:00:00Z')),
    ).resolves.toBe(true);
    // El calculo es en la zona horaria DEL RECINTO, dentro del SQL.
    expect(manager.query).toHaveBeenCalledWith(expect.stringContaining('AT TIME ZONE'), [
      'site-id',
      '2026-08-03T15:00:00.000Z',
    ]);
    const sql = String(manager.query.mock.calls[0]?.[0]);
    expect(sql).toContain('site_holidays');
    expect(sql).toContain('holiday_date = m.local_ts::date');
    expect(sql).toMatch(/site_business_hours[\s\S]+OR EXISTS \([\s\S]+site_holidays/);
    expect(sql).not.toContain(')) AS within');
    // Con horario definido, las reglas del tenant no se consultan.
    expect(rules.effective).not.toHaveBeenCalled();
  });

  it('fuera del horario definido del recinto', async () => {
    const manager = { query: jest.fn().mockResolvedValue([{ has_hours: true, within: false }]) };

    await expect(
      servicio(manager).isWithinBusinessHours('site-id', new Date('2026-08-03T03:00:00Z')),
    ).resolves.toBe(false);
  });

  it('recinto sin horario definido: decide la regla del tenant, no el codigo', async () => {
    const sinHorario = () =>
      ({ query: jest.fn().mockResolvedValue([{ has_hours: false, within: false }]) });

    await expect(
      servicio(sinHorario(), reglas()).isWithinBusinessHours('site-id'),
    ).resolves.toBe(true); // default del producto: abierto

    await expect(
      servicio(sinHorario(), reglas({ businessHoursDefaultOpen: false }))
        .isWithinBusinessHours('site-id'),
    ).resolves.toBe(false);
  });

  /**
   * businessHoursDefaultOpen es HASTA_RECINTO en PATROL_RULE_CATALOG, y el
   * siteId es el parametro de esta funcion: resolverla sin contexto ignoraba al
   * recinto que la configuro, justo en la decision para la que la configuro.
   *
   * El mock DISTINGUE el contexto a proposito. Uno que devuelva lo mismo se le
   * pase lo que se le pase no prueba nada: es el mock mentiroso de la regla #5
   * de la casa, y con el este test pasaba tambien con el bug adentro.
   */
  it('el recinto sin horario cargado decide con SU regla, no con la del tenant', async () => {
    const manager = { query: jest.fn().mockResolvedValue([{ has_hours: false, within: false }]) };
    const defaults = patrolRulesSchema.parse({});
    const rules = {
      effective: jest.fn(async (contexto?: { siteId?: string }) => ({
        ...defaults,
        // El tenant dice "abierto"; el recinto lo apaga en site_rules.
        businessHoursDefaultOpen: contexto?.siteId ? false : true,
      })),
    } as unknown as RulesService;

    await expect(servicio(manager, rules).isWithinBusinessHours('site-id')).resolves.toBe(false);
    expect(rules.effective).toHaveBeenCalledWith({ siteId: 'site-id' });
  });

  it('un feriado cuenta como configuracion aunque el recinto no tenga horario semanal', async () => {
    const manager = { query: jest.fn().mockResolvedValue([{ has_hours: true, within: false }]) };
    const rules = reglas({ businessHoursDefaultOpen: true });

    await expect(servicio(manager, rules).isWithinBusinessHours('site-id')).resolves.toBe(false);
    expect(rules.effective).not.toHaveBeenCalled();
  });

  it('recinto inexistente: 404, no un false silencioso', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };

    await expect(servicio(manager).isWithinBusinessHours('site-x')).rejects.toThrow(
      'El recinto no existe',
    );
  });
});

describe('EvidenceService.requiresPhoto', () => {
  const punto = (extra = {}) => ({
    id: 'cp-1',
    site_id: 'site-id',
    kind: 'normal',
    requires_photo: null,
    ...extra,
  });

  it('con la regla de fuera-de-horario ENCENDIDA, la foto es obligatoria aunque el punto no la exija', async () => {
    // Apagada de fabrica desde el 8-ago (la foto la exige una tarea, no el
    // reloj); este test cubre a la empresa que la enciende.
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([punto()]) // punto normal, sin override
      .mockResolvedValueOnce([{ has_hours: true, within: false }]);

    await expect(
      servicio(manager, reglas({ photoRequiredOutsideHours: true })).requiresPhoto('cp-1'),
    ).resolves.toMatchObject({
      required: true,
      withinBusinessHours: false,
    });
  });

  it('en horario habil un punto normal no exige foto', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([punto()])
      .mockResolvedValueOnce([{ has_hours: true, within: true }]);

    await expect(servicio(manager).requiresPhoto('cp-1')).resolves.toMatchObject({
      required: false,
      withinBusinessHours: true,
    });
  });

  it('en horario habil un acceso critico exige foto igual', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([punto({ kind: 'acceso_critico' })])
      .mockResolvedValueOnce([{ has_hours: true, within: true }]);

    await expect(servicio(manager).requiresPhoto('cp-1')).resolves.toMatchObject({
      required: true,
    });
  });

  it('el override tri-estado del punto manda sobre horario y reglas', async () => {
    // Semantica de isPhotoRequired() en @sentrycore/shared: el punto sobreescribe
    // la regla global en cualquier direccion, incluso fuera de horario.
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([punto({ requires_photo: false })])
      .mockResolvedValueOnce([{ has_hours: true, within: false }]);

    await expect(servicio(manager).requiresPhoto('cp-1')).resolves.toMatchObject({
      required: false,
    });
  });

  /**
   * La cascada es plataforma -> tenant -> RECINTO -> PUNTO, y la foto se puede
   * configurar en los cuatro niveles (ver PATROL_RULE_CATALOG). Resolver las
   * reglas sin contexto devolvia solo los dos primeros: un admin que apagaba
   * photoRequiredOnCritical en un recinto veia el cambio ignorado justo en la
   * decision para la que lo configuro.
   */
  it('resuelve las reglas con el recinto y el punto, no con la cascada a medias', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([punto({ kind: 'acceso_critico' })])
      .mockResolvedValueOnce([{ has_hours: true, within: true }]);
    const rules = reglas();

    await servicio(manager, rules).requiresPhoto('cp-1');

    expect(rules.effective).toHaveBeenCalledWith({ siteId: 'site-id', checkpointId: 'cp-1' });
  });
});

describe('EvidenceService.storePhoto', () => {
  it('rechaza un mime que no es jpeg ni png, antes de tocar la base', async () => {
    const manager = { query: jest.fn() };
    const pdf: FotoSubida = {
      mimetype: 'application/pdf',
      size: 10,
      buffer: Buffer.from('%PDF-1.4'),
    };

    await expect(
      servicio(manager).storePhoto('scan-id', 'guard-id', pdf),
    ).rejects.toThrow('Solo se acepta evidencia image/jpeg o image/png');
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('rechaza contenido que no corresponde al formato declarado', async () => {
    const manager = { query: jest.fn() };
    const disfrazado: FotoSubida = {
      mimetype: 'image/jpeg',
      size: 20,
      buffer: Buffer.from('no soy una imagen....'),
    };

    await expect(
      servicio(manager).storePhoto('scan-id', 'guard-id', disfrazado),
    ).rejects.toThrow('El contenido del archivo no corresponde al formato declarado');
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('rechaza la foto que supera el maximo configurado del tenant', async () => {
    const manager = { query: jest.fn() };
    const gigante = { ...fotoPng(), size: 2 * 1024 * 1024 };

    await expect(
      servicio(manager, reglas({ photoMaxSizeMB: 1 })).storePhoto('scan-id', 'guard-id', gigante),
    ).rejects.toThrow('supera el maximo de 1 MB');
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('rechaza si el buffer real supera el limite aunque el campo size declare menos', async () => {
    const manager = { query: jest.fn() };
    const bufferGrande = Buffer.alloc(2 * 1024 * 1024);
    // Firma PNG + IHDR
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bufferGrande, 0);
    bufferGrande.writeUInt32BE(13, 8);
    bufferGrande.write('IHDR', 12, 'ascii');
    bufferGrande.writeUInt32BE(640, 16);
    bufferGrande.writeUInt32BE(480, 20);

    const archivoManipulado: FotoSubida = {
      mimetype: 'image/png',
      size: 100, // declaracion falsa
      buffer: bufferGrande,
    };

    await expect(
      servicio(manager, reglas({ photoMaxSizeMB: 1 })).storePhoto('scan-id', 'guard-id', archivoManipulado),
    ).rejects.toThrow('supera el maximo de 1 MB');
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('sanitiza takenAtDevice vacio o con espacios a null', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([ESCANEO])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'foto-id', created_at: new Date('2026-08-03T04:00:00Z') }]);

    const res = await servicio(manager).storePhoto('scan-id', 'guard-id', fotoPng(), '   ');
    expect(res.takenAtDevice).toBeNull();
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO scan_photos'),
      expect.arrayContaining([null]),
    );
  });

  it('rechaza con 409 la MISMA imagen reusada en otro punto (sha duplicado)', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([ESCANEO]) // el escaneo del guardia
      .mockResolvedValueOnce([{ id: 'foto-previa' }]); // ese sha ya existe en el tenant

    await expect(
      servicio(manager).storePhoto('scan-id', 'guard-id', fotoPng()),
    ).rejects.toThrow('foto reusada');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('guarda el archivo bajo tenant/ronda y registra la fila con sha y dimensiones', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([ESCANEO])
      .mockResolvedValueOnce([]) // sha nuevo
      .mockResolvedValueOnce([{ id: 'foto-id', created_at: new Date('2026-08-03T04:00:00Z') }]);

    await expect(
      servicio(manager).storePhoto('scan-id', 'guard-id', fotoPng(), '2026-08-03T03:59:20Z'),
    ).resolves.toMatchObject({
      id: 'foto-id',
      scanId: 'scan-id',
      patrolId: 'patrol-1',
      checkpointId: 'cp-1',
      width: 640,
      height: 480,
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      takenAtDevice: '2026-08-03T03:59:20Z',
    });
    expect(mkdir).toHaveBeenCalledWith(expect.stringContaining('tenant-1'), { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(expect.stringContaining('patrol-1'), expect.any(Buffer));
    expect(manager.query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (tenant_id, sha256) DO NOTHING'),
      expect.arrayContaining(['scan-id', 'patrol-1', 'cp-1']),
    );
  });

  it('la carrera contra la UNIQUE tambien responde 409 y no deja archivo huerfano', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([ESCANEO])
      .mockResolvedValueOnce([]) // el pre-chequeo no lo vio
      .mockResolvedValueOnce([]); // pero el INSERT choco con la constraint

    await expect(
      servicio(manager).storePhoto('scan-id', 'guard-id', fotoPng()),
    ).rejects.toThrow('foto reusada');
    expect(rm).toHaveBeenCalledWith(expect.stringContaining('tenant-1'), { force: true });
  });

  it('el escaneo de otro guardia no recibe evidencia ajena', async () => {
    const manager = { query: jest.fn().mockResolvedValue([]) };

    await expect(
      servicio(manager).storePhoto('scan-id', 'otro-guardia', fotoPng()),
    ).rejects.toThrow('El escaneo no existe o no pertenece a tus rondas');
  });
});

describe('EvidenceService.listByPatrol', () => {
  it('devuelve las fotos de la ronda en orden de captura, para el anexo', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([{ id: 'patrol-1', site_id: 'site-id' }])
      .mockResolvedValueOnce([
        {
          id: 'foto-id',
          scan_id: 'scan-id',
          checkpoint_id: 'cp-1',
          checkpoint_name: 'Porteria',
          storage_path: 'tenant-1/patrol-1/abc.jpg',
          mime_type: 'image/jpeg',
          size_bytes: '123456',
          width: 640,
          height: 480,
          sha256: 'a'.repeat(64),
          taken_at_device: null,
          created_at: new Date('2026-08-03T04:00:00Z'),
        },
      ]);

    await expect(
      servicio(manager).listByPatrol('patrol-1', { sub: 'admin-id', role: 'ADMIN' }),
    ).resolves.toMatchObject({
      patrolId: 'patrol-1',
      count: 1,
      photos: [
        {
          id: 'foto-id',
          checkpointName: 'Porteria',
          sizeBytes: 123456,
          storagePath: 'tenant-1/patrol-1/abc.jpg',
        },
      ],
    });
  });

  it('el supervisor sin el recinto asignado no ve el anexo', async () => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([{ id: 'patrol-1', site_id: 'site-id' }])
      .mockResolvedValueOnce([]); // sin fila en supervisor_sites

    await expect(
      servicio(manager).listByPatrol('patrol-1', { sub: 'sup-id', role: 'SUPERVISOR' }),
    ).rejects.toThrow('No tienes este recinto asignado');
  });
});

/*
 * La cache del informe (#266, #320) da por inmutable a la ronda cerrada, y no
 * lo es: la cola offline sube la foto cuando vuelve la señal, y para entonces
 * el ultimo escaneo ya pudo haber cerrado la ronda. Sin invalidar, el primer
 * PDF descargado despues del cierre se congela SIN esa foto.
 */
describe('EvidenceService.storePhoto — foto tardia sobre ronda cerrada (#320)', () => {
  const subidaOk = (estadoRonda: string) => {
    const manager = { query: jest.fn() };
    manager.query
      .mockResolvedValueOnce([{ ...ESCANEO, patrol_status: estadoRonda }])
      .mockResolvedValueOnce([]) // sha nuevo
      .mockResolvedValueOnce([{ id: 'foto-id', created_at: new Date('2026-08-03T04:00:00Z') }]);
    return manager;
  };

  it('pide el estado de la ronda en la misma consulta que autoriza el escaneo', async () => {
    const manager = subidaOk('completada');
    await servicio(manager, reglas(), { invalidarCache: jest.fn().mockResolvedValue(undefined) })
      .storePhoto('scan-id', 'guard-id', fotoPng());

    expect(String(manager.query.mock.calls[0]?.[0])).toContain('p.status AS patrol_status');
  });

  it.each(['completada', 'incompleta', 'vencida'])(
    'tumba el PDF cacheado cuando la ronda esta %s',
    async (estado) => {
      const patrolReport = { invalidarCache: jest.fn().mockResolvedValue(undefined) };
      await servicio(subidaOk(estado), reglas(), patrolReport).storePhoto(
        'scan-id',
        'guard-id',
        fotoPng(),
      );

      expect(patrolReport.invalidarCache).toHaveBeenCalledWith('tenant-1', 'patrol-1');
    },
  );

  it('no toca la cache si la ronda sigue en curso: todavia no hay PDF que congelar', async () => {
    const patrolReport = { invalidarCache: jest.fn().mockResolvedValue(undefined) };
    await servicio(subidaOk('en_curso'), reglas(), patrolReport).storePhoto(
      'scan-id',
      'guard-id',
      fotoPng(),
    );

    expect(patrolReport.invalidarCache).not.toHaveBeenCalled();
  });

  it('la foto se guarda igual aunque la invalidacion falle', async () => {
    const patrolReport = {
      invalidarCache: jest.fn().mockRejectedValue(new Error('volumen de solo lectura')),
    };

    await expect(
      servicio(subidaOk('completada'), reglas(), patrolReport).storePhoto(
        'scan-id',
        'guard-id',
        fotoPng(),
      ),
    ).resolves.toMatchObject({ id: 'foto-id' });
  });
});

/*
 * El contenedor de Nest resuelve por el TIPO del parametro del constructor
 * (design:paramtypes). Con `import type` ese tipo se borra al compilar, el
 * parametro queda como Object y la API NO ARRANCA: se cae entera al inicio,
 * con typecheck, lint y build en verde. Ya paso una vez y tumbo staging.
 */
describe('EvidenceService — metadatos de inyeccion', () => {
  it('el constructor declara PatrolReportService como tipo, no Object', () => {
    const tipos = Reflect.getMetadata('design:paramtypes', EvidenceService) as unknown[];
    expect(tipos[3]).toBe(PatrolReportService);
  });
});
