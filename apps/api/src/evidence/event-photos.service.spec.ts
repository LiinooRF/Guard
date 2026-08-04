import type { ConfigService } from '@nestjs/config';
import { patrolRulesSchema, type PatrolRules } from '@voxia/shared';

import { EventPhotosService } from './event-photos.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';
import type { FotoSubida } from './photo-validation';

jest.mock('node:fs/promises', () => ({
  mkdir: jest.fn().mockResolvedValue(undefined),
  writeFile: jest.fn().mockResolvedValue(undefined),
  rm: jest.fn().mockResolvedValue(undefined),
}));

import { rm, writeFile } from 'node:fs/promises';

const reglas = (overrides: Partial<PatrolRules> = {}) =>
  ({
    effective: jest.fn().mockResolvedValue({ ...patrolRulesSchema.parse({}), ...overrides }),
  }) as unknown as RulesService;

const servicio = (manager: { query: jest.Mock }, rules: RulesService = reglas()) =>
  new EventPhotosService(
    { manager } as unknown as TenantContextService,
    rules,
    { getOrThrow: jest.fn().mockReturnValue('/evidencia') } as unknown as ConfigService,
  );

/** PNG minimo valido: firma + IHDR con 640x480. */
const fotoPng = (relleno = 0): FotoSubida => {
  const buffer = Buffer.alloc(25);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0);
  buffer.writeUInt32BE(13, 8);
  buffer.write('IHDR', 12, 'ascii');
  buffer.writeUInt32BE(640, 16);
  buffer.writeUInt32BE(480, 20);
  // Un byte que cambia el sha256 sin romper el encabezado: sirve para probar
  // que dos fotos DISTINTAS si conviven.
  buffer.writeUInt8(relleno, 24);
  return { mimetype: 'image/png', size: buffer.length, buffer };
};

const EVENTO = { id: 'e1', tenant_id: 't1' };
const GUARDIA = 'g1';

// Los mocks del sistema de archivos son de modulo: sin esto, una escritura de
// un caso anterior hace pasar por bueno un "no escribio nada" de este.
beforeEach(() => {
  jest.clearAllMocks();
});

describe('EventPhotosService.store', () => {
  it('guarda la foto bajo la carpeta de novedades del tenant, con ruta relativa', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([EVENTO]) // la novedad existe y es del guardia
      .mockResolvedValueOnce([]) // sin sha repetido
      .mockResolvedValueOnce([{ id: 'f1', created_at: new Date('2026-03-01T10:00:00Z') }]);

    const resultado = await servicio({ query }).store(EVENTO.id, GUARDIA, fotoPng());

    expect(resultado).toMatchObject({ eventId: 'e1', width: 640, height: 480 });
    const rutaGuardada = (writeFile as jest.Mock).mock.calls.at(-1)?.[0] as string;
    expect(rutaGuardada).toContain('novedades');
    // La fila guarda la ruta RELATIVA, sin el prefijo del volumen: mover
    // EVIDENCE_PATH no puede invalidar las filas ya escritas.
    const rutaEnFila = query.mock.calls[2][1][1] as string;
    expect(rutaEnFila).not.toContain('/evidencia');
    expect(rutaEnFila).toContain('t1');
  });

  it('no deja adjuntar una foto a la novedad de otro guardia', async () => {
    // La consulta filtra por guard_id, asi que "de otro" llega como vacio.
    const query = jest.fn().mockResolvedValueOnce([]);
    await expect(servicio({ query }).store(EVENTO.id, GUARDIA, fotoPng())).rejects.toThrow(
      /no la reportaste tu/,
    );
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('rechaza la imagen ya usada: es la foto reusada, el fraude de evidencia', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([EVENTO])
      .mockResolvedValueOnce([{ id: 'ya-existe' }]);
    await expect(servicio({ query }).store(EVENTO.id, GUARDIA, fotoPng())).rejects.toThrow(
      /foto reusada/,
    );
  });

  it('si otra subida identica gana la carrera, borra el archivo y no deja huerfano', async () => {
    // El pre-chequeo pasa pero el INSERT no devuelve fila: gano el ON CONFLICT.
    const query = jest
      .fn()
      .mockResolvedValueOnce([EVENTO])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await expect(servicio({ query }).store(EVENTO.id, GUARDIA, fotoPng())).rejects.toThrow(
      /foto reusada/,
    );
    expect(rm).toHaveBeenCalled();
  });

  it('aplica el tamaño maximo del TENANT, no un numero fijo', async () => {
    const query = jest.fn();
    const grande = { ...fotoPng(), size: 3 * 1024 * 1024 };
    await expect(
      servicio({ query }, reglas({ photoMaxSizeMB: 2 })).store(EVENTO.id, GUARDIA, grande),
    ).rejects.toThrow(/2 MB/);
    // Ni siquiera se consulto la novedad: el tamaño se corta antes.
    expect(query).not.toHaveBeenCalled();
  });

  it('rechaza el archivo cuyo contenido no corresponde al mime declarado', async () => {
    const query = jest.fn();
    const disfrazado: FotoSubida = {
      mimetype: 'image/png',
      size: 10,
      buffer: Buffer.from('no soy un png'),
    };
    await expect(servicio({ query }).store(EVENTO.id, GUARDIA, disfrazado)).rejects.toThrow(
      /no corresponde al formato declarado/,
    );
  });
});

describe('EventPhotosService.listByEvent', () => {
  const FOTO_FILA = {
    id: 'f1',
    storage_path: 't1/novedades/e1/abc.png',
    mime_type: 'image/png',
    size_bytes: '2048',
    width: 640,
    height: 480,
    sha256: 'a'.repeat(64),
    taken_at_device: null,
    created_at: new Date('2026-03-01T10:00:00Z'),
  };

  it('el ADMIN ve las fotos de cualquier novedad de su tenant', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'e1', site_id: 's1' }])
      .mockResolvedValueOnce([FOTO_FILA]);
    const salida = await servicio({ query }).listByEvent('e1', { sub: 'a1', role: 'ADMIN' });
    expect(salida.count).toBe(1);
    // bigint llega como string desde el driver y sale como numero.
    expect(salida.photos[0]?.sizeBytes).toBe(2048);
  });

  it('al SUPERVISOR no le basta el permiso: tiene que tener el recinto asignado', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'e1', site_id: 's1' }])
      .mockResolvedValueOnce([]); // no aparece en supervisor_sites
    await expect(
      servicio({ query }).listByEvent('e1', { sub: 'sv1', role: 'SUPERVISOR' }),
    ).rejects.toThrow(/recinto asignado/);
  });

  it('novedad inexistente da 404 y no filtra si es de otro tenant', async () => {
    // RLS ya deja la fila fuera del resultado, asi que "de otro tenant" y
    // "no existe" son el mismo caso desde aca, y esa es la respuesta correcta.
    const query = jest.fn().mockResolvedValueOnce([]);
    await expect(
      servicio({ query }).listByEvent('e1', { sub: 'a1', role: 'ADMIN' }),
    ).rejects.toThrow(/no existe/);
  });
});
