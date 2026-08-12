import { patrolRulesSchema } from '@voxia/shared';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';

import type { ConfigService } from '@nestjs/config';
import type { BrandingService } from '../branding/branding.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { FeatureFlagsService } from '../rules/feature-flags.service';
import type { RulesService } from '../rules/rules.service';
import { PatrolReportService } from './patrol-report.service';

/**
 * Tests del servicio completo: consultas, marca, permisos y el render real
 * sobre un stream. No se inspecciona el binario mas alla de que sea un PDF
 * valido — lo que importa es que la evidencia rota no lo tumbe y que la marca
 * que sale sea la del tenant.
 */

const RONDA = {
  id: 'patrol-id',
  status: 'completada',
  scheduled_start_at: new Date('2026-07-30T22:00:00-04:00'),
  scheduled_end_at: new Date('2026-07-31T06:00:00-04:00'),
  started_at: new Date('2026-07-30T22:05:00-04:00'),
  closed_at: new Date('2026-07-31T05:40:00-04:00'),
  compliance_pct: '100.00',
  site_id: 'site-1',
  site_name: 'Planta Norte',
  branch_name: 'Casa matriz',
  timezone: 'America/Santiago',
  route_name: 'Ronda nocturna',
  guard_name: 'Juan Soto',
};

const PUNTOS = [
  { position: '1', id: 'cp-1', name: 'Acceso principal', kind: 'normal', is_closing_point: false },
  { position: '2', id: 'cp-2', name: 'Portería', kind: 'acceso_critico', is_closing_point: true },
];

const SCANS = [
  {
    checkpoint_id: 'cp-1',
    method: 'nfc',
    scanned_at_server: new Date('2026-07-30T23:10:00-04:00'),
    scanned_at_device: null,
    anomalies: [],
  },
];

/**
 * JPEG minimo que pdfkit acepta embeber: SOI + SOF0 con dimensiones y 3
 * canales. Los datos de imagen son basura a proposito — aca se prueba que la
 * generacion no se cae, no como se ve la foto.
 */
function jpegEmbebible(ancho = 16, alto = 12): Buffer {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt16BE(0xffd8, 0);
  buffer.writeUInt8(0xff, 2);
  buffer.writeUInt8(0xc0, 3);
  buffer.writeUInt16BE(17, 4);
  buffer.writeUInt8(8, 6);
  buffer.writeUInt16BE(alto, 7);
  buffer.writeUInt16BE(ancho, 9);
  buffer.writeUInt8(3, 11);
  return buffer;
}

interface Fixture {
  encabezado?: unknown[];
  puntos?: unknown[];
  scans?: unknown[];
  incidentes?: unknown[];
  fotos?: unknown[];
  tareas?: unknown[];
  asignaciones?: unknown[];
}

/**
 * Manager falso que responde por el CONTENIDO del SQL y no por el orden de las
 * llamadas: asi un test no se rompe porque se agrego una consulta antes.
 *
 * El orden de las ramas SI importa: la de las tareas va antes que la del
 * encabezado porque la consulta de tareas tambien menciona `patrols`.
 */
function fakeManager(fixture: Fixture) {
  return {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('supervisor_sites')) return fixture.asignaciones ?? [];
      if (sql.includes('FROM checklist_items')) return fixture.tareas ?? [];
      if (sql.includes('jsonb_array_elements_text')) return fixture.puntos ?? PUNTOS;
      if (sql.includes('FROM scans')) return fixture.scans ?? SCANS;
      if (sql.includes('FROM field_events')) return fixture.incidentes ?? [];
      if (sql.includes('FROM scan_photos')) return fixture.fotos ?? [];
      if (sql.includes('FROM patrols p')) return fixture.encabezado ?? [RONDA];
      throw new Error(`consulta no esperada: ${sql}`);
    }),
  };
}

interface MarcaFake {
  displayName: string;
  logoUri: string | null;
  primaryColor: string;
  mailFromName: string;
  mailFooter: string | null;
}

const MARCA_TENANT: MarcaFake = {
  displayName: 'Vigilancia Austral Ltda',
  logoUri: null,
  primaryColor: '#7a1f1f',
  mailFromName: 'Vigilancia Austral Ltda',
  mailFooter: 'Vigilancia Austral Ltda · Región de Los Lagos',
};

function armarServicio(
  fixture: Fixture,
  extras: { raiz?: string; umbral?: number; marca?: MarcaFake; photoAppendix?: boolean } = {},
) {
  const manager = fakeManager(fixture);
  const rules = {
    effective: jest
      .fn()
      .mockResolvedValue(
        patrolRulesSchema.parse(
          extras.umbral === undefined ? {} : { complianceThreshold: extras.umbral },
        ),
      ),
  } as unknown as RulesService;
  const branding = {
    forDocuments: jest.fn().mockResolvedValue(extras.marca ?? MARCA_TENANT),
  } as unknown as BrandingService;
  // El anexo del PDF depende del flag `photoAppendix` (#286). Por defecto el
  // modulo esta prendido, que es como venia antes de gatearlo.
  const features = {
    isEnabled: jest.fn().mockResolvedValue(extras.photoAppendix ?? true),
  } as unknown as FeatureFlagsService;
  const config = {
    getOrThrow: jest.fn().mockReturnValue(extras.raiz ?? '/vol/evidencia'),
  } as unknown as ConfigService;

  const service = new PatrolReportService(
    { manager } as unknown as TenantContextService,
    rules,
    branding,
    features,
    config,
  );
  return { service, manager, rules, branding, features };
}

/** Recoge lo que el servicio escribe en el stream, como haria la respuesta HTTP. */
async function recolectar(
  correr: (destino: NodeJS.WritableStream) => Promise<unknown>,
): Promise<Buffer> {
  const canal = new PassThrough();
  const partes: Buffer[] = [];
  canal.on('data', (parte: Buffer) => partes.push(parte));
  await correr(canal);
  return Buffer.concat(partes);
}

const esPdf = (pdf: Buffer) => pdf.subarray(0, 5).toString('latin1') === '%PDF-';

describe('PatrolReportService.buildModel', () => {
  it('arma el modelo con la marca del TENANT, no con el nombre legal', async () => {
    // La consulta de la ronda ya ni siquiera trae tenants.display_name: la
    // unica fuente del nombre en el informe es BrandingService.
    const { service, branding } = armarServicio({});

    const modelo = await service.buildModel('patrol-id');

    expect(modelo.marca).toEqual({
      displayName: 'Vigilancia Austral Ltda',
      logoUri: null,
      primaryColor: '#7a1f1f',
      mailFooter: 'Vigilancia Austral Ltda · Región de Los Lagos',
    });
    expect(branding.forDocuments).toHaveBeenCalledTimes(1);
  });

  it('la ronda inexistente lanza NotFound sin consultar nada más', async () => {
    const { service, manager } = armarServicio({ encabezado: [] });

    await expect(service.buildModel('patrol-fantasma')).rejects.toThrow('La ronda no existe');
    expect(manager.query).toHaveBeenCalledTimes(1);
  });

  it('usa el umbral del tenant para decidir belowThreshold', async () => {
    const { service } = armarServicio({}, { umbral: 40 });

    const modelo = await service.buildModel('patrol-id');

    // 1 de 2 puntos = 50%, sobre un umbral de 40.
    expect(modelo.compliance.pct).toBe(50);
    expect(modelo.compliance.belowThreshold).toBe(false);
    expect(modelo.omitidos.map((p) => p.checkpointId)).toEqual(['cp-2']);
  });

  it('trae las tareas del turno y las deja en el modelo', async () => {
    const { service } = armarServicio({
      tareas: [
        {
          item_id: 'it-1',
          position: 1,
          label: 'Fotografiar el refrigerador',
          response_type: 'ok_falla',
          requires_photo: true,
          requires_photo_on_fail: false,
          // `time` de PostgreSQL: string, no Date. Es como llega de verdad.
          due_local_time: '11:00:00',
          checkpoint_id: 'cp-2',
          checkpoint_name: 'Portería',
          response_id: 'rs-1',
          value: 'ok',
          notes: null,
          failed: false,
          photo_id: null,
          late_minutes: 35,
          responded_at: new Date('2026-07-31T00:35:00-04:00'),
        },
      ],
    });

    const modelo = await service.buildModel('patrol-id');

    expect(modelo.tareas).toHaveLength(1);
    expect(modelo.tareas[0]).toMatchObject({
      horaPedida: '11:00',
      numeroPunto: 2,
      atrasoMinutos: 35,
      atrasada: true,
      faltaFoto: true,
    });
    // Las tareas no tocan el cumplimiento, que sigue siendo sobre puntos.
    expect(modelo.compliance.pct).toBe(50);
  });

  it('una ronda sin checklist deja las tareas vacías y no cambia el resto', async () => {
    const { service } = armarServicio({});

    const modelo = await service.buildModel('patrol-id');

    expect(modelo.tareas).toEqual([]);
    expect(modelo.puntos).toHaveLength(2);
  });

  it('sin anexo no consulta siquiera los metadatos de las fotos', async () => {
    const { service, manager } = armarServicio({});

    const modelo = await service.buildModel('patrol-id', { incluirAnexo: false });

    expect(modelo.anexo).toEqual([]);
    expect(
      manager.query.mock.calls.some(([sql]) => String(sql).includes('FROM scan_photos')),
    ).toBe(false);
  });

  it('con el modulo photoAppendix APAGADO el PDF sale sin anexo (#286)', async () => {
    // El flag era un control muerto: el anexo se incluia siempre. Ahora, cuando
    // el llamador no opina (el PDF que se descarga), manda el modulo del tenant.
    const { service, manager } = armarServicio({}, { photoAppendix: false });

    const modelo = await service.buildModel('patrol-id');

    expect(modelo.incluyeAnexo).toBe(false);
    expect(modelo.anexo).toEqual([]);
    // Y no gasta la consulta de metadatos de fotos si no las va a mostrar.
    expect(
      manager.query.mock.calls.some(([sql]) => String(sql).includes('FROM scan_photos')),
    ).toBe(false);
  });

  it('un llamador que pide incluirAnexo:false gana sobre el flag (el correo)', async () => {
    const { service } = armarServicio({}, { photoAppendix: true });
    const modelo = await service.buildModel('patrol-id', { incluirAnexo: false });
    expect(modelo.incluyeAnexo).toBe(false);
  });
});

describe('PatrolReportService · alcance del SUPERVISOR', () => {
  const supervisor = { sub: 'sup-1', role: 'SUPERVISOR' as const };

  it('un SUPERVISOR sin el recinto asignado recibe 403 aunque tenga reports:read', async () => {
    // El permiso no alcanza: el SUPERVISOR esta limitado a SUS recintos.
    const { service, manager } = armarServicio({ asignaciones: [] });

    await expect(
      service.buildModel('patrol-id', { requester: supervisor }),
    ).rejects.toThrow('No tienes este recinto asignado');
    // Se corta antes de leer los puntos de la ronda.
    expect(
      manager.query.mock.calls.some(([sql]) => String(sql).includes('jsonb_array_elements_text')),
    ).toBe(false);
  });

  it('un SUPERVISOR con el recinto asignado sí obtiene el informe', async () => {
    const { service } = armarServicio({ asignaciones: [{ present: true }] });

    const modelo = await service.buildModel('patrol-id', { requester: supervisor });

    expect(modelo.patrolId).toBe('patrol-id');
  });

  it('el ADMIN no gatilla la verificación por recinto', async () => {
    const { service, manager } = armarServicio({});

    await service.buildModel('patrol-id', { requester: { sub: 'adm-1', role: 'ADMIN' } });

    expect(
      manager.query.mock.calls.some(([sql]) => String(sql).includes('supervisor_sites')),
    ).toBe(false);
  });

  it('sin requester (la cola de #86) tampoco la gatilla', async () => {
    const { service, manager } = armarServicio({});

    await service.buildModel('patrol-id', { requester: null });

    expect(
      manager.query.mock.calls.some(([sql]) => String(sql).includes('supervisor_sites')),
    ).toBe(false);
  });
});

describe('PatrolReportService.render · streaming y evidencia', () => {
  let raiz: string;

  beforeEach(async () => {
    raiz = await mkdtemp(join(tmpdir(), 'voxia-informe-'));
    await mkdir(join(raiz, 'tenant', 'patrol'), { recursive: true });
  });

  afterEach(async () => {
    await rm(raiz, { recursive: true, force: true });
  });

  const fotoRow = (id: string, archivo: string) => ({
    id,
    checkpoint_id: 'cp-2',
    checkpoint_name: 'Portería',
    storage_path: `tenant/patrol/${archivo}`,
    mime_type: 'image/jpeg',
    size_bytes: '2048',
    sha256: 'b'.repeat(64),
    taken_at_device: null,
    created_at: new Date('2026-07-31T05:41:00-04:00'),
  });

  it('escribe un PDF válido en el stream, sin materializarlo en un Buffer', async () => {
    const { service } = armarServicio({}, { raiz });

    const pdf = await recolectar((destino) => service.streamTo('patrol-id', destino));

    expect(esPdf(pdf)).toBe(true);
    expect(pdf.length).toBeGreaterThan(1000);
    expect(pdf.subarray(-8).toString('latin1')).toContain('%%EOF');
  });

  it('incluye en el anexo la foto que sí está en el volumen', async () => {
    await writeFile(join(raiz, 'tenant', 'patrol', 'ok.jpg'), jpegEmbebible());
    const { service } = armarServicio({ fotos: [fotoRow('f1', 'ok.jpg')] }, { raiz });

    let resumen;
    const pdf = await recolectar(async (destino) => {
      resumen = await service.streamTo('patrol-id', destino);
    });

    expect(esPdf(pdf)).toBe(true);
    expect(resumen).toMatchObject({ fotosIncluidas: 1, fotosOmitidas: 0, paginasAnexo: 1 });
  });

  it('una foto que falta en el volumen NO tumba el informe entero', async () => {
    // El caso del issue: la fila existe en scan_photos pero el archivo no esta.
    const { service } = armarServicio({ fotos: [fotoRow('f1', 'fantasma.jpg')] }, { raiz });

    let resumen;
    const pdf = await recolectar(async (destino) => {
      resumen = await service.streamTo('patrol-id', destino);
    });

    expect(esPdf(pdf)).toBe(true);
    expect(resumen).toMatchObject({ fotosIncluidas: 0, fotosOmitidas: 1 });
  });

  it('una foto corrupta se marca y las sanas del mismo anexo se dibujan igual', async () => {
    await writeFile(join(raiz, 'tenant', 'patrol', 'ok.jpg'), jpegEmbebible());
    await writeFile(join(raiz, 'tenant', 'patrol', 'rota.jpg'), Buffer.from('basura'));
    const { service } = armarServicio(
      { fotos: [fotoRow('f1', 'rota.jpg'), fotoRow('f2', 'ok.jpg')] },
      { raiz },
    );

    let resumen;
    const pdf = await recolectar(async (destino) => {
      resumen = await service.streamTo('patrol-id', destino);
    });

    expect(esPdf(pdf)).toBe(true);
    expect(resumen).toMatchObject({ fotosIncluidas: 1, fotosOmitidas: 1 });
  });

  it('el anexo pagina de a 4 fotos por hoja', async () => {
    await writeFile(join(raiz, 'tenant', 'patrol', 'ok.jpg'), jpegEmbebible());
    const fotos = Array.from({ length: 9 }, (_, i) => fotoRow(`f${i}`, 'ok.jpg'));
    const { service } = armarServicio({ fotos }, { raiz });

    let resumen;
    await recolectar(async (destino) => {
      resumen = await service.streamTo('patrol-id', destino);
    });

    expect(resumen).toMatchObject({ fotosIncluidas: 9, paginasAnexo: 3 });
  });

  it('un consumidor lento recibe el PDF completo y no cuelga la generación', async () => {
    // El anexo cede el event loop entre foto y foto para no acumular salida en
    // el buffer interno de pdfkit, que ignora el backpressure. Este test cubre
    // que esa espera no se transforme en un bloqueo.
    await writeFile(join(raiz, 'tenant', 'patrol', 'ok.jpg'), jpegEmbebible());
    const fotos = Array.from({ length: 5 }, (_, i) => fotoRow(`f${i}`, 'ok.jpg'));
    const { service } = armarServicio({ fotos }, { raiz });

    const partes: Buffer[] = [];
    const lento = new Writable({
      write(parte: Buffer, _codificacion, listo) {
        partes.push(Buffer.from(parte));
        setTimeout(listo, 5);
      },
    });

    const resumen = await service.streamTo('patrol-id', lento);
    const pdf = Buffer.concat(partes);

    expect(esPdf(pdf)).toBe(true);
    expect(pdf.subarray(-8).toString('latin1')).toContain('%%EOF');
    expect(resumen).toMatchObject({ fotosIncluidas: 5 });
  }, 30_000);

  it('la sección de tareas del turno no tumba la generación del PDF', async () => {
    // No se inspecciona el binario: lo que se cubre es que dibujar la seccion
    // nueva —con falla, atraso y foto faltante a la vez— no lance, porque una
    // excepcion aca sale como un PDF cortado a mitad del cable.
    const { service } = armarServicio(
      {
        tareas: [
          {
            item_id: 'it-1',
            position: 1,
            label: 'Fotografiar el refrigerador',
            response_type: 'ok_falla',
            requires_photo: true,
            requires_photo_on_fail: false,
            due_local_time: '11:00:00',
            checkpoint_id: 'cp-2',
            checkpoint_name: 'Portería',
            response_id: 'rs-1',
            value: 'falla',
            notes: 'puerta entreabierta',
            failed: true,
            photo_id: null,
            late_minutes: 35,
            responded_at: new Date('2026-07-31T00:35:00-04:00'),
          },
          {
            item_id: 'it-2',
            position: 2,
            label: 'Revisar bitácora del turno',
            response_type: 'texto',
            requires_photo: false,
            requires_photo_on_fail: false,
            due_local_time: null,
            checkpoint_id: null,
            checkpoint_name: null,
            response_id: null,
            value: null,
            notes: null,
            failed: null,
            photo_id: null,
            late_minutes: null,
            responded_at: null,
          },
        ],
      },
      { raiz },
    );

    const pdf = await recolectar((destino) => service.streamTo('patrol-id', destino));

    expect(esPdf(pdf)).toBe(true);
    expect(pdf.subarray(-8).toString('latin1')).toContain('%%EOF');
  });

  it('una ronda sin escaneos ni fotos genera el PDF igual', async () => {
    const { service } = armarServicio({ scans: [] }, { raiz });

    const pdf = await recolectar((destino) => service.streamTo('patrol-id', destino));

    expect(esPdf(pdf)).toBe(true);
  });

  it('un logo de marca inválido no impide generar el informe', async () => {
    const { service } = armarServicio(
      {},
      {
        raiz,
        marca: { ...MARCA_TENANT, logoUri: 'data:image/svg+xml;base64,PHN2Zy8+' },
      },
    );

    const pdf = await recolectar((destino) => service.streamTo('patrol-id', destino));

    expect(esPdf(pdf)).toBe(true);
  });
});

describe('PatrolReportService.toBuffer', () => {
  it('devuelve los bytes y por defecto SIN anexo, para el adjunto del correo', async () => {
    const { service, manager } = armarServicio({});

    const informe = await service.toBuffer('patrol-id');

    expect(esPdf(informe.pdf)).toBe(true);
    expect(informe.filename).toBe('informe-ronda-patrol-id.pdf');
    expect(informe.tenantName).toBe('Vigilancia Austral Ltda');
    expect(informe.compliance).toMatchObject({ pct: 50, scanned: 1, expected: 2 });
    expect(informe.render.fotosIncluidas).toBe(0);
    expect(
      manager.query.mock.calls.some(([sql]) => String(sql).includes('FROM scan_photos')),
    ).toBe(false);
  });

  it('con incluirAnexo explícito sí consulta las fotos', async () => {
    const { service, manager } = armarServicio({});

    await service.toBuffer('patrol-id', { incluirAnexo: true });

    expect(
      manager.query.mock.calls.some(([sql]) => String(sql).includes('FROM scan_photos')),
    ).toBe(true);
  });
});
