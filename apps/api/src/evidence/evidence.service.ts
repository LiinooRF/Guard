import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isPhotoRequired } from '@sentrycore/shared';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RulesService } from '../rules/rules.service';
import { type FotoSubida, validarImagen } from './photo-validation';

export type { FotoSubida };

const FOTO_REUSADA = 'Esta imagen ya respalda otro escaneo del tenant: foto reusada';

@Injectable()
export class EvidenceService {
  private readonly evidencePath: string;

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly rules: RulesService,
    config: ConfigService,
  ) {
    this.evidencePath = config.getOrThrow<string>('EVIDENCE_PATH');
  }

  /**
   * ¿El recinto esta en horario habil en el instante dado?
   *
   * El calculo es en la zona horaria DEL RECINTO (sites.timezone), no la del
   * servidor ni la del telefono. Un tramo con opens_at > closes_at cruza
   * medianoche (22:00-06:00): la madrugada pertenece a la fila del dia
   * ANTERIOR, por eso la segunda rama del OR.
   *
   * Recinto sin horario definido: decide la regla businessHoursDefaultOpen
   * DEL RECINTO, nunca un valor fijo en el codigo.
   */
  async isWithinBusinessHours(siteId: string, cuando: Date = new Date()): Promise<boolean> {
    const rows = await this.tenantContext.manager.query<
      Array<{ has_hours: boolean; within: boolean }>
    >(
      `
        WITH momento AS (
          SELECT s.tenant_id, s.id AS site_id,
                 ($2::timestamptz AT TIME ZONE s.timezone) AS local_ts
          FROM sites s
          WHERE s.id = $1
        )
        SELECT
          EXISTS (
            SELECT 1 FROM site_business_hours h
            WHERE h.tenant_id = m.tenant_id AND h.site_id = m.site_id
          ) OR EXISTS (
            SELECT 1 FROM site_holidays f
            WHERE f.tenant_id = m.tenant_id AND f.site_id = m.site_id
              AND f.holiday_date = m.local_ts::date
          ) AS has_hours,
          NOT EXISTS (
            SELECT 1 FROM site_holidays f
            WHERE f.tenant_id = m.tenant_id AND f.site_id = m.site_id
              AND f.holiday_date = m.local_ts::date
          ) AND (
            EXISTS (
              SELECT 1 FROM site_business_hours h
              WHERE h.tenant_id = m.tenant_id AND h.site_id = m.site_id
                AND h.weekday = EXTRACT(DOW FROM m.local_ts)::int
                AND (
                  (h.opens_at < h.closes_at
                    AND m.local_ts::time >= h.opens_at
                    AND m.local_ts::time < h.closes_at)
                  OR (h.opens_at > h.closes_at AND m.local_ts::time >= h.opens_at)
                )
            )
            OR EXISTS (
              SELECT 1 FROM site_business_hours h
              WHERE h.tenant_id = m.tenant_id AND h.site_id = m.site_id
                AND h.weekday = (EXTRACT(DOW FROM m.local_ts)::int + 6) % 7
                AND h.opens_at > h.closes_at
                AND m.local_ts::time < h.closes_at
            )
          ) AS within
        FROM momento m
      `,
      [siteId, cuando.toISOString()],
    );

    const row = rows[0];
    if (!row) throw new NotFoundException('El recinto no existe');

    if (!row.has_hours) {
      // businessHoursDefaultOpen se configura HASTA_RECINTO: sin el siteId, el
      // recinto que la ajusta queda ignorado justo en la decision para la que
      // la configuro. Y el siteId lo tenemos: es el parametro de esta funcion.
      const rules = await this.rules.effective({ siteId });
      return rules.businessHoursDefaultOpen;
    }
    return row.within;
  }

  /**
   * ¿Este punto exige foto en este instante? Es lo que consulta el flujo de
   * escaneo. Combina el override tri-estado del punto, las reglas efectivas
   * del tenant y el horario del recinto via isPhotoRequired() de @sentrycore/shared
   * — la logica vive alla y no se reimplementa aca.
   */
  async requiresPhoto(checkpointId: string, cuando: Date = new Date()) {
    const rows = await this.tenantContext.manager.query<
      Array<{
        id: string;
        site_id: string;
        kind: 'normal' | 'acceso_critico';
        requires_photo: boolean | null;
      }>
    >(
      `SELECT id, site_id, kind, requires_photo FROM checkpoints WHERE id = $1`,
      [checkpointId],
    );
    const checkpoint = rows[0];
    if (!checkpoint) throw new NotFoundException('El punto de control no existe');

    const withinBusinessHours = await this.isWithinBusinessHours(checkpoint.site_id, cuando);
    // La cascada completa: plataforma -> tenant -> RECINTO -> PUNTO. Sin el
    // contexto, effective() devuelve solo los niveles plataforma y tenant, y un
    // admin que apaga photoRequiredOnCritical en un recinto veia el cambio
    // ignorado justo en la decision para la que lo configuro.
    const rules = await this.rules.effective({
      siteId: checkpoint.site_id,
      checkpointId: checkpoint.id,
    });

    return {
      required: isPhotoRequired({
        checkpoint: { kind: checkpoint.kind, requiresPhoto: checkpoint.requires_photo },
        withinBusinessHours,
        rules,
      }),
      withinBusinessHours,
      checkpoint: {
        id: checkpoint.id,
        kind: checkpoint.kind,
        requiresPhoto: checkpoint.requires_photo,
      },
    };
  }

  /**
   * Recibe la evidencia de un escaneo: valida el formato por CONTENIDO, aplica
   * el tamaño maximo del tenant, rechaza con 409 la imagen ya usada (sha256
   * repetido = foto reusada, EL fraude de evidencia), guarda el archivo bajo
   * EVIDENCE_PATH/tenant/ronda/ y registra la fila.
   *
   * La app movil (#67) garantiza camara-nunca-galeria; aca ademas queda
   * taken_at_device para detectar del lado servidor fotos tomadas mucho antes
   * del escaneo.
   */
  async storePhoto(
    scanId: string,
    guardId: string,
    archivo: FotoSubida,
    takenAtDevice?: string,
  ) {
    const rules = await this.rules.effective();
    const imagen = validarImagen(archivo, rules.photoMaxSizeMB);

    // El guardia solo adjunta evidencia a escaneos de SUS rondas.
    const scans = await this.tenantContext.manager.query<
      Array<{ id: string; tenant_id: string; patrol_id: string; checkpoint_id: string }>
    >(
      `SELECT sc.id, sc.tenant_id, sc.patrol_id, sc.checkpoint_id
       FROM scans sc
       JOIN patrols p ON p.tenant_id = sc.tenant_id AND p.id = sc.patrol_id
       WHERE sc.id = $1 AND p.guard_id = $2`,
      [scanId, guardId],
    );
    const scan = scans[0];
    if (!scan) throw new NotFoundException('El escaneo no existe o no pertenece a tus rondas');

    const { sha256 } = imagen;
    const duplicadas = await this.tenantContext.manager.query<Array<{ id: string }>>(
      `SELECT id FROM scan_photos WHERE sha256 = $1`,
      [sha256],
    );
    if (duplicadas.length) throw new ConflictException(FOTO_REUSADA);

    // Ruta RELATIVA a EVIDENCE_PATH: mover el volumen no invalida las filas.
    const rutaRelativa = join(scan.tenant_id, scan.patrol_id, `${sha256}.${imagen.extension}`);
    const rutaAbsoluta = join(this.evidencePath, rutaRelativa);
    await mkdir(join(this.evidencePath, scan.tenant_id, scan.patrol_id), { recursive: true });
    await writeFile(rutaAbsoluta, archivo.buffer);

    const insertadas = await this.tenantContext.manager.query<
      Array<{ id: string; created_at: Date }>
    >(
      `INSERT INTO scan_photos (
        tenant_id, scan_id, patrol_id, checkpoint_id, storage_path, mime_type,
        size_bytes, width, height, sha256, taken_at_device
      ) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (tenant_id, sha256) DO NOTHING
      RETURNING id, created_at`,
      [
        scanId,
        scan.patrol_id,
        scan.checkpoint_id,
        rutaRelativa,
        archivo.mimetype,
        archivo.size,
        imagen.width,
        imagen.height,
        sha256,
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
      scanId,
      patrolId: scan.patrol_id,
      checkpointId: scan.checkpoint_id,
      mimeType: archivo.mimetype,
      sizeBytes: archivo.size,
      width: imagen.width,
      height: imagen.height,
      sha256,
      takenAtDevice: takenAtDevice ?? null,
      createdAt: foto.created_at,
    };
  }

  /** Las fotos de una ronda, en orden de captura: el anexo del informe (#17). */
  async listByPatrol(patrolId: string, requester: Pick<AuthenticatedUser, 'sub' | 'role'>) {
    const patrols = await this.tenantContext.manager.query<
      Array<{ id: string; site_id: string }>
    >(`SELECT id, site_id FROM patrols WHERE id = $1`, [patrolId]);
    const patrol = patrols[0];
    if (!patrol) throw new NotFoundException('La ronda no existe');

    // El SUPERVISOR esta limitado a SUS recintos asignados (ver roles.ts);
    // el permiso reports:read no basta por si solo.
    if (requester.role === 'SUPERVISOR') {
      const asignado = await this.tenantContext.manager.query<Array<{ present: boolean }>>(
        `SELECT true AS present FROM supervisor_sites
         WHERE site_id = $1 AND supervisor_id = $2`,
        [patrol.site_id, requester.sub],
      );
      if (!asignado.length) throw new ForbiddenException('No tienes este recinto asignado');
    }

    const fotos = await this.tenantContext.manager.query<
      Array<{
        id: string;
        scan_id: string;
        checkpoint_id: string;
        checkpoint_name: string;
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
      `SELECT ph.id, ph.scan_id, ph.checkpoint_id, c.name AS checkpoint_name,
              ph.storage_path, ph.mime_type, ph.size_bytes, ph.width, ph.height,
              ph.sha256, ph.taken_at_device, ph.created_at
       FROM scan_photos ph
       JOIN checkpoints c ON c.tenant_id = ph.tenant_id AND c.id = ph.checkpoint_id
       WHERE ph.patrol_id = $1
       ORDER BY ph.created_at`,
      [patrolId],
    );

    return {
      patrolId,
      count: fotos.length,
      photos: fotos.map((f) => ({
        id: f.id,
        scanId: f.scan_id,
        checkpointId: f.checkpoint_id,
        checkpointName: f.checkpoint_name,
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
