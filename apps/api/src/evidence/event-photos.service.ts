import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RulesService } from '../rules/rules.service';
import { type FotoSubida, validarImagen } from './photo-validation';

const FOTO_REUSADA = 'Esta imagen ya respalda otra evidencia del tenant: foto reusada';

/** Carpeta de las novedades dentro del tenant. Los ids de ronda son UUID, no colisiona. */
const CARPETA_NOVEDADES = 'novedades';

/**
 * La evidencia fotografica del libro de novedades (#122).
 *
 * Va aparte de EvidenceService porque el sujeto es otro: alla la foto respalda
 * un escaneo dentro de una ronda; aca respalda un hecho que puede no tener
 * ronda —un vidrio roto al llegar, antes de iniciar el turno—.
 */
@Injectable()
export class EventPhotosService {
  private readonly evidencePath: string;

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly rules: RulesService,
    config: ConfigService,
  ) {
    this.evidencePath = config.getOrThrow<string>('EVIDENCE_PATH');
  }

  /**
   * Adjunta la foto a una novedad ya registrada.
   *
   * Va en dos pasos —primero la novedad, despues la foto— y no en uno solo a
   * proposito: el guardia reporta desde terreno, muchas veces sin señal, y el
   * texto pesa bytes mientras la foto pesa megas. Si fuera una sola peticion,
   * una subida cortada se llevaria tambien el reporte, que es la parte que
   * importa. Por eso la web sube la foto recien cuando tiene el id del servidor
   * y avisa si esa segunda parte falla.
   */
  async store(eventId: string, guardId: string, archivo: FotoSubida, takenAtDevice?: string) {
    const reglas = await this.rules.effective();
    const imagen = validarImagen(archivo, reglas.photoMaxSizeMB);

    // Solo el autor adjunta evidencia a su novedad. El libro es append-only:
    // dejar que un tercero cuelgue fotos en el reporte de otro lo convertiria
    // en un registro que el autor no puede desmentir ni corregir.
    const eventos = await this.tenantContext.manager.query<
      Array<{ id: string; tenant_id: string }>
    >(`SELECT id, tenant_id FROM field_events WHERE id = $1 AND guard_id = $2`, [eventId, guardId]);
    const evento = eventos[0];
    if (!evento) throw new NotFoundException('La novedad no existe o no la reportaste tu');

    const duplicadas = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `SELECT id FROM event_photos WHERE sha256 = $1`,
      [imagen.sha256],
    );
    if (duplicadas.length) throw new ConflictException(FOTO_REUSADA);

    // Ruta RELATIVA a EVIDENCE_PATH: mover el volumen no invalida las filas.
    const rutaRelativa = join(
      evento.tenant_id,
      CARPETA_NOVEDADES,
      eventId,
      `${imagen.sha256}.${imagen.extension}`,
    );
    const rutaAbsoluta = join(this.evidencePath, rutaRelativa);
    await mkdir(join(this.evidencePath, evento.tenant_id, CARPETA_NOVEDADES, eventId), {
      recursive: true,
    });
    await writeFile(rutaAbsoluta, archivo.buffer);

    const insertadas = await this.tenantContext.manager.query<
      Array<{ id: string; created_at: Date }>
    >(
      `INSERT INTO event_photos (
        tenant_id, event_id, storage_path, mime_type, size_bytes, width, height,
        sha256, taken_at_device
      ) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (tenant_id, sha256) DO NOTHING
      RETURNING id, created_at`,
      [
        eventId,
        rutaRelativa,
        archivo.mimetype,
        archivo.size,
        imagen.width,
        imagen.height,
        imagen.sha256,
        takenAtDevice ?? null,
      ],
    );
    const foto = insertadas[0];
    if (!foto) {
      // Carrera: otra subida del mismo contenido gano entre el chequeo y el
      // INSERT. Mismo veredicto que el pre-chequeo, sin archivo huerfano.
      await rm(rutaAbsoluta, { force: true });
      throw new ConflictException(FOTO_REUSADA);
    }

    return {
      id: foto.id,
      eventId,
      mimeType: archivo.mimetype,
      sizeBytes: archivo.size,
      width: imagen.width,
      height: imagen.height,
      sha256: imagen.sha256,
      takenAtDevice: takenAtDevice ?? null,
      createdAt: foto.created_at,
    };
  }

  /** Las fotos de una novedad, en orden de captura. */
  async listByEvent(eventId: string, requester: Pick<AuthenticatedUser, 'sub' | 'role'>) {
    const eventos = await this.tenantContext.manager.query<Array<{ id: string; site_id: string }>>(
      `SELECT id, site_id FROM field_events WHERE id = $1`,
      [eventId],
    );
    const evento = eventos[0];
    if (!evento) throw new NotFoundException('La novedad no existe');

    // El SUPERVISOR esta limitado a SUS recintos asignados (ver roles.ts);
    // el permiso reports:read no basta por si solo.
    if (requester.role === 'SUPERVISOR') {
      const asignado = await this.tenantContext.manager.query<Array<{ present: boolean }>>(
        `SELECT true AS present FROM supervisor_sites
         WHERE site_id = $1 AND supervisor_id = $2`,
        [evento.site_id, requester.sub],
      );
      if (!asignado.length) throw new ForbiddenException('No tienes este recinto asignado');
    }

    const fotos = await this.tenantContext.manager.query<
      Array<{
        id: string;
        storage_path: string;
        mime_type: string;
        size_bytes: string | number;
        width: number | null;
        height: number | null;
        sha256: string;
        taken_at_device: Date | null;
        created_at: Date;
      }>
    >(
      `SELECT id, storage_path, mime_type, size_bytes, width, height, sha256,
              taken_at_device, created_at
       FROM event_photos
       WHERE event_id = $1
       ORDER BY created_at`,
      [eventId],
    );

    return {
      eventId,
      count: fotos.length,
      photos: fotos.map((f) => ({
        id: f.id,
        storagePath: f.storage_path,
        mimeType: f.mime_type,
        // bigint llega como string desde el driver.
        sizeBytes: Number(f.size_bytes),
        width: f.width,
        height: f.height,
        sha256: f.sha256,
        takenAtDevice: f.taken_at_device,
        createdAt: f.created_at,
      })),
    };
  }
}
