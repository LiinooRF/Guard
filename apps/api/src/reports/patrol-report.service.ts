import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassThrough } from 'node:stream';
import type { ComplianceResult } from '@voxia/shared';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { BrandingService } from '../branding/branding.service';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RulesService } from '../rules/rules.service';
import {
  construirInformeRonda,
  type EncabezadoRondaRow,
  type FotoRow,
  type IncidenteRow,
  type InformeRonda,
  type PuntoEsperadoRow,
  type ScanRow,
} from './patrol-report.model';
import { renderizarInformeRonda, type ResumenRender } from './patrol-report.renderer';

/**
 * Generacion del informe PDF de una ronda ejecutada (#85).
 *
 * Es un SERVICIO y no logica del controlador porque tiene dos consumidores: la
 * descarga desde el panel y el envio automatico al cierre de la ronda (#86),
 * que corre en un worker de BullMQ sin request HTTP alrededor. La API publica
 * esta pensada para los dos:
 *
 *   buildModel()  -> resuelve datos, marca y permisos. Aca se lanzan 404/403,
 *                    ANTES de escribir un solo byte.
 *   render()      -> dibuja sobre cualquier Writable (respuesta HTTP, archivo).
 *   toBuffer()    -> los bytes en memoria, para adjuntar a un correo.
 *
 * La separacion en dos fases es lo que permite responder un 404 en JSON: una
 * vez que empezo el streaming ya no hay vuelta atras.
 */

export interface OpcionesInforme {
  /**
   * Quien pide el informe. `null` = contexto de sistema (la cola de #86), que
   * ya corre dentro del tenant correcto y no tiene usuario.
   */
  readonly requester?: Pick<AuthenticatedUser, 'sub' | 'role'> | null;
  /**
   * El anexo fotografico puede pesar decenas de MB. El envio automatico por
   * correo genera el informe SIN anexo (el job viaja por Redis y el adjunto por
   * SMTP); la descarga del panel lo incluye.
   */
  readonly incluirAnexo?: boolean;
}

export interface InformeRondaPdf {
  readonly pdf: Buffer;
  readonly filename: string;
  readonly patrolId: string;
  readonly tenantName: string;
  readonly compliance: ComplianceResult;
  readonly render: ResumenRender;
}

@Injectable()
export class PatrolReportService {
  private readonly logger = new Logger(PatrolReportService.name);
  private readonly raizEvidencia: string;

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly rules: RulesService,
    private readonly branding: BrandingService,
    config: ConfigService,
  ) {
    this.raizEvidencia = config.getOrThrow<string>('EVIDENCE_PATH');
  }

  /**
   * Reune todo lo que el informe necesita: cabecera, puntos en su orden
   * EFECTIVO, escaneos, incidentes, fotos y la marca del tenant.
   *
   * Ninguna consulta trae bytes de imagen: del anexo solo se leen rutas y
   * metadatos, y el contenido se abre archivo por archivo al dibujar.
   */
  async buildModel(patrolId: string, opciones: OpcionesInforme = {}): Promise<InformeRonda> {
    const { requester = null, incluirAnexo = true } = opciones;

    const encabezados = await this.tenantContext.manager.query<EncabezadoRondaRow[]>(
      `
        SELECT
          p.id,
          p.status,
          p.scheduled_start_at,
          p.scheduled_end_at,
          p.started_at,
          p.closed_at,
          p.compliance_pct,
          p.site_id,
          s.name AS site_name,
          s.branch_name,
          s.timezone,
          r.name AS route_name,
          (u.given_name || ' ' || u.family_name) AS guard_name
        FROM patrols p
        JOIN sites s ON s.tenant_id = p.tenant_id AND s.id = p.site_id
        JOIN routes r ON r.tenant_id = p.tenant_id AND r.id = p.route_id
        JOIN users u ON u.id = p.guard_id
        WHERE p.id = $1
      `,
      [patrolId],
    );
    const ronda = encabezados[0];
    if (!ronda) throw new NotFoundException('La ronda no existe');

    await this.verificarAlcance(ronda.site_id, requester);

    // expected_checkpoint_ids es el orden EFECTIVO (puede venir sorteado por
    // randomizeRouteOrder): la tabla del informe respeta ese orden, no el de la
    // ruta.
    const puntos = await this.tenantContext.manager.query<PuntoEsperadoRow[]>(
      `
        SELECT
          ord.position,
          c.id,
          c.name,
          c.kind,
          COALESCE(rc.is_closing_point, false) AS is_closing_point
        FROM patrols p
        CROSS JOIN LATERAL jsonb_array_elements_text(p.expected_checkpoint_ids)
          WITH ORDINALITY AS ord(checkpoint_id, position)
        JOIN checkpoints c ON c.tenant_id = p.tenant_id AND c.id = ord.checkpoint_id::uuid
        LEFT JOIN route_checkpoints rc
          ON rc.tenant_id = p.tenant_id
          AND rc.route_id = p.route_id
          AND rc.checkpoint_id = c.id
        WHERE p.id = $1
        ORDER BY ord.position
      `,
      [patrolId],
    );

    const scans = await this.tenantContext.manager.query<ScanRow[]>(
      `
        SELECT checkpoint_id, method, scanned_at_server, scanned_at_device, anomalies
        FROM scans
        WHERE patrol_id = $1
        ORDER BY scanned_at_server
      `,
      [patrolId],
    );

    const incidentes = await this.tenantContext.manager.query<IncidenteRow[]>(
      `
        SELECT id, criticality, text, reported_at_server
        FROM field_events
        WHERE patrol_id = $1
        ORDER BY reported_at_server
      `,
      [patrolId],
    );

    const fotos = incluirAnexo ? await this.leerMetadatosFotos(patrolId) : [];

    const [reglas, marca] = await Promise.all([
      this.rules.effective(),
      this.branding.forDocuments(),
    ]);

    return construirInformeRonda({
      ronda,
      puntos,
      scans,
      fotos,
      incidentes,
      // La marca del TENANT, no la de la plataforma ni la del revendedor: en un
      // producto white-label un informe con la marca equivocada es el cliente
      // viendo la marca de otro.
      marca: {
        displayName: marca.displayName,
        logoUri: marca.logoUri,
        primaryColor: marca.primaryColor,
        mailFooter: marca.mailFooter,
      },
      umbral: reglas.complianceThreshold,
      incluirAnexo,
      criticidadesDestacadas: reglas.escalationCriticalities,
    });
  }

  /** Dibuja el informe ya resuelto sobre el destino que decida el llamador. */
  async render(modelo: InformeRonda, destino: NodeJS.WritableStream): Promise<ResumenRender> {
    const reglas = await this.rules.effective();
    return renderizarInformeRonda(modelo, destino, {
      raizEvidencia: this.raizEvidencia,
      // El mismo techo que aplica al subir la foto (#13): si una imagen supera
      // el maximo del tenant, esta corrupta o alguien la escribio a mano en el
      // volumen, y cargarla es justo lo que no queremos.
      maxBytesFoto: reglas.photoMaxSizeMB * 1024 * 1024,
      onEvidenciaFallida: (fotoId, motivo) => {
        // Log sin nombres ni ubicaciones de personas (regla 5 de CLAUDE.md).
        this.logger.warn(
          JSON.stringify({
            event: 'evidencia_no_incluida_en_informe',
            patrolId: modelo.patrolId,
            photoId: fotoId,
            motivo,
          }),
        );
      },
    });
  }

  /** Atajo de una sola llamada para servir el PDF por streaming. */
  async streamTo(
    patrolId: string,
    destino: NodeJS.WritableStream,
    opciones: OpcionesInforme = {},
  ): Promise<ResumenRender> {
    const modelo = await this.buildModel(patrolId, opciones);
    return this.render(modelo, destino);
  }

  /**
   * El informe completo en memoria.
   *
   * Existe para el adjunto del correo (#86), que necesita los bytes si o si.
   * Por defecto va SIN anexo: un PDF de 40 fotos no es un adjunto, y el camino
   * de descarga del panel —que si lleva anexo— nunca pasa por aca.
   */
  async toBuffer(patrolId: string, opciones: OpcionesInforme = {}): Promise<InformeRondaPdf> {
    const modelo = await this.buildModel(patrolId, {
      ...opciones,
      incluirAnexo: opciones.incluirAnexo ?? false,
    });

    const canal = new PassThrough();
    const partes: Buffer[] = [];
    canal.on('data', (parte: Buffer) => partes.push(parte));
    const resumen = await this.render(modelo, canal);

    return {
      pdf: Buffer.concat(partes),
      filename: modelo.filename,
      patrolId: modelo.patrolId,
      tenantName: modelo.marca.displayName,
      compliance: modelo.compliance,
      render: resumen,
    };
  }

  // ------------------------------------------------------------------ datos

  private async leerMetadatosFotos(patrolId: string): Promise<FotoRow[]> {
    return this.tenantContext.manager.query<FotoRow[]>(
      `
        SELECT ph.id, ph.checkpoint_id, c.name AS checkpoint_name, ph.storage_path,
               ph.mime_type, ph.size_bytes, ph.sha256, ph.taken_at_device, ph.created_at
        FROM scan_photos ph
        JOIN checkpoints c ON c.tenant_id = ph.tenant_id AND c.id = ph.checkpoint_id
        WHERE ph.patrol_id = $1
        ORDER BY ph.created_at
      `,
      [patrolId],
    );
  }

  /**
   * El SUPERVISOR esta limitado a SUS recintos asignados: el permiso
   * reports:read no alcanza por si solo (ver roles.ts y CLAUDE.md). RLS ya
   * aisla por tenant; esta verificacion es la que falta dentro del tenant.
   */
  private async verificarAlcance(
    siteId: string,
    requester: Pick<AuthenticatedUser, 'sub' | 'role'> | null,
  ): Promise<void> {
    if (requester === null || requester.role !== 'SUPERVISOR') return;

    const asignado = await this.tenantContext.manager.query<Array<{ present: boolean }>>(
      `SELECT true AS present FROM supervisor_sites
       WHERE site_id = $1 AND supervisor_id = $2`,
      [siteId, requester.sub],
    );
    if (!asignado.length) throw new ForbiddenException('No tienes este recinto asignado');
  }
}
