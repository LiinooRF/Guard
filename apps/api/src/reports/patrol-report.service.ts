import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { ComplianceResult } from '@sentrycore/shared';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { BrandingService } from '../branding/branding.service';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { FeatureFlagsService } from '../rules/feature-flags.service';
import { MapaRecorridoService } from './mapa-recorrido.service';
import { RulesService } from '../rules/rules.service';
import {
  construirInformeRonda,
  type EncabezadoRondaRow,
  type FotoRow,
  type IncidenteRow,
  type InformeRonda,
  type PuntoEsperadoRow,
  type ScanRow,
  type TareaRow,
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

/**
 * Las tareas del turno de esta ronda, respondidas o no (#265).
 *
 * Se exporta para que `informes.integration.spec.ts` corra EXACTAMENTE este
 * texto contra el esquema real: es una consulta con nombres de columna nuevos y
 * un mock jamas diria si `late_minutes` o `due_local_time` existen.
 *
 * QUE PLANTILLA SE LISTA. Un LEFT JOIN desde checklist_items es obligatorio —la
 * tarea NO hecha no tiene fila en checklist_responses y es justo la que hay que
 * mostrar—, pero eso obliga a elegir una plantilla, y la ronda no la tiene
 * congelada como si congela `expected_checkpoint_ids`. Manda la plantilla de
 * los items YA RESPONDIDOS: es la unica que consta que el guardia vio. La
 * vigente hoy se usa solo cuando no contesto nada, porque una ronda de julio
 * puede resolver ahora a una plantilla creada en agosto y el informe estaria
 * inventando tareas que nunca existieron.
 */
export const SQL_TAREAS_DEL_TURNO = `
  WITH ronda AS (
    SELECT rp.id, rp.site_id, sa.shift_id
    FROM patrols rp
    LEFT JOIN shift_assignments sa
      ON sa.tenant_id = rp.tenant_id AND sa.id = rp.shift_assignment_id
    WHERE rp.id = $1
  ),
  respondida AS (
    SELECT i.template_id
    FROM checklist_responses r
    JOIN checklist_items i ON i.tenant_id = r.tenant_id AND i.id = r.item_id
    WHERE r.patrol_id = $1
    GROUP BY i.template_id
    ORDER BY count(*) DESC, i.template_id
    LIMIT 1
  ),
  elegida AS (
    (SELECT template_id FROM respondida)
    UNION ALL
    (SELECT t.id
     FROM checklist_templates t, ronda
     WHERE NOT EXISTS (SELECT 1 FROM respondida)
       AND t.is_active
       AND (t.site_id IS NULL OR t.site_id = ronda.site_id)
       AND (t.shift_id IS NULL OR t.shift_id = ronda.shift_id)
     ORDER BY (t.site_id IS NOT NULL)::int + (t.shift_id IS NOT NULL)::int DESC
     LIMIT 1)
  )
  SELECT
    i.id AS item_id,
    i.position,
    i.label,
    i.response_type,
    i.requires_photo,
    i.requires_photo_on_fail,
    i.due_local_time,
    i.checkpoint_id,
    c.name AS checkpoint_name,
    r.id AS response_id,
    r.value,
    r.notes,
    r.failed,
    r.photo_id,
    r.late_minutes,
    r.responded_at
  FROM checklist_items i
  JOIN elegida e ON e.template_id = i.template_id
  LEFT JOIN checklist_responses r
    ON r.tenant_id = i.tenant_id AND r.item_id = i.id AND r.patrol_id = $1
  LEFT JOIN checkpoints c
    ON c.tenant_id = i.tenant_id AND c.id = i.checkpoint_id
  ORDER BY i.due_local_time ASC NULLS LAST, i.position
`;

/**
 * Los puntos esperados en su orden EFECTIVO, con lo que hay que revisar en cada
 * uno.
 *
 * Se exporta por la misma razon que SQL_TAREAS_DEL_TURNO: `c.instructions`
 * entro en #308 y un mock diria que si existe aunque la columna se llamara de
 * otra forma. Contra el esquema real la consulta habla sola.
 */
export const SQL_PUNTOS_ESPERADOS = `
  SELECT
    ord.position,
    c.id,
    c.name,
    c.kind,
    c.instructions,
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
`;

/**
 * Metadatos de la evidencia: rutas, huellas y horas. NUNCA bytes.
 *
 * `ph.scan_id` entro en #308 para poder agrupar la evidencia de una misma
 * lectura sin depender de `created_at`, que es la hora de subida.
 */
export const SQL_FOTOS_DE_LA_RONDA = `
  SELECT ph.id, ph.scan_id, ph.checkpoint_id, c.name AS checkpoint_name, ph.storage_path,
         ph.mime_type, ph.size_bytes, ph.sha256, ph.taken_at_device, ph.created_at
  FROM scan_photos ph
  JOIN checkpoints c ON c.tenant_id = ph.tenant_id AND c.id = ph.checkpoint_id
  WHERE ph.patrol_id = $1
  ORDER BY ph.created_at
`;

@Injectable()
export class PatrolReportService {
  private readonly logger = new Logger(PatrolReportService.name);
  private readonly raizEvidencia: string;

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly rules: RulesService,
    private readonly branding: BrandingService,
    private readonly features: FeatureFlagsService,
    private readonly mapaRecorrido: MapaRecorridoService,
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
    const { requester = null } = opciones;
    // El anexo fotografico es un MODULO de plan (#286). Cuando el llamador no
    // opina —el PDF que se descarga desde el panel— manda el flag `photoAppendix`
    // de la empresa: antes se incluia SIEMPRE y prender/apagar el modulo no hacia
    // nada. El envio por correo sigue pasando `false` explicito (el anexo no viaja
    // en el adjunto, se baja del panel) y eso gana sobre el flag.
    const incluirAnexo = opciones.incluirAnexo ?? (await this.features.isEnabled('photoAppendix'));

    const encabezados = await this.tenantContext.manager.query<EncabezadoRondaRow[]>(
      `
        SELECT
          p.id,
          p.tenant_id,
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
      SQL_PUNTOS_ESPERADOS,
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

    // Una ronda sin checklist devuelve cero filas y el informe sale igual que
    // antes de #265: sin seccion de tareas y sin una linea de mas.
    const tareas = await this.tenantContext.manager.query<TareaRow[]>(SQL_TAREAS_DEL_TURNO, [
      patrolId,
    ]);

    // Sin condicional: son metadatos, no bytes, y el peso del adjunto no cambia.
    // Lo que decide `incluirAnexo` es si se abre el archivo al dibujar.
    const fotos = await this.leerMetadatosFotos(patrolId);

    const [reglas, marca] = await Promise.all([
      this.rules.effective(),
      this.branding.forDocuments(),
    ]);


    const modelo = construirInformeRonda({
      ronda,
      puntos,
      scans,
      fotos,
      incidentes,
      tareas,
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

    // El recorrido (#79) se arma DESPUES del modelo porque necesita los puntos ya
    // resueltos (`FilaPunto`), no las filas crudas: el mapa ubica cada marca por
    // su numero de punto. Solo va cuando el informe lleva anexo — el liviano del
    // correo se manda sin mapa por lo mismo que sin fotos, que es pesar poco.
    // `construir` devuelve null si el tenant apago la regla `reportIncludeMap`.
    const mapa = incluirAnexo
      ? await this.mapaRecorrido.construir(patrolId, modelo.puntos, { requester })
      : null;

    return { ...modelo, mapa };
  }

  /**
   * Ruta en el volumen de evidencia donde se guarda el PDF inmutable de la ronda
   * cerrada (#266).
   */
  private rutaCache(tenantId: string, patrolId: string, incluirAnexo: boolean): string {
    return join(
      this.raizEvidencia,
      tenantId,
      patrolId,
      incluirAnexo ? 'informe-ronda-anexo.pdf' : 'informe-ronda.pdf',
    );
  }

  /**
   * Una ronda cerrada es inmutable: su informe no vuelve a cambiar y se sirve
   * desde la copia en disco (#266).
   */
  private esRondaCerrada(estado: string): boolean {
    return ['completada', 'incompleta', 'vencida'].includes(estado);
  }

  /** Dibuja el informe ya resuelto sobre el destino que decida el llamador. */
  async render(modelo: InformeRonda, destino: NodeJS.WritableStream): Promise<ResumenRender> {
    const tenantId = modelo.tenantId;
    const cerrada = this.esRondaCerrada(modelo.estado);
    const rutaCache = tenantId ? this.rutaCache(tenantId, modelo.patrolId, modelo.incluyeAnexo) : null;

    if (cerrada && rutaCache) {
      try {
        const stats = await stat(rutaCache);
        if (stats.size > 0) {
          const lector = createReadStream(rutaCache);
          lector.pipe(destino);
          await new Promise<void>((resolve, reject) => {
            lector.on('end', resolve);
            lector.on('error', reject);
          });
          return { fotosIncluidas: 0, fotosOmitidas: 0, paginasAnexo: 0 };
        }
      } catch {
        // No está en cache todavía: se dibuja y guarda en disco.
      }
    }

    const reglas = await this.rules.effective();
    const partes: Buffer[] = [];

    const resumen = await renderizarInformeRonda(modelo, destino, {
      raizEvidencia: this.raizEvidencia,
      // El mismo techo que aplica al subir la foto (#13): si una imagen supera
      // el maximo del tenant, esta corrupta o alguien la escribio a mano en el
      // volumen, y cargarla es justo lo que no queremos.
      maxBytesFoto: reglas.photoMaxSizeMB * 1024 * 1024,
      // Forma del informe (#308). Ninguna de las cuatro es una constante del
      // renderer: son decisiones de cada cliente y viven en la cascada.
      bitacora: reglas.reportTimeline,
      fotosEnLinea: reglas.reportInlinePhotos,
      etiquetaConfidencial: reglas.reportConfidentialLabel,
      maxEntradasBitacora: reglas.reportTimelineMaxEntries,
      onChunk: cerrada && rutaCache ? (chunk: Buffer) => partes.push(chunk) : undefined,
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

    if (cerrada && rutaCache && partes.length > 0) {
      try {
        const bufferCompleto = Buffer.concat(partes);
        await mkdir(join(this.raizEvidencia, tenantId!, modelo.patrolId), { recursive: true });
        await writeFile(rutaCache, bufferCompleto);
      } catch (error) {
        this.logger.warn(
          JSON.stringify({
            event: 'cache_informe_escritura_fallida',
            patrolId: modelo.patrolId,
            message: error instanceof Error ? error.message : 'error desconocido',
          }),
        );
      }
    }

    return resumen;
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
    const incluirAnexo = opciones.incluirAnexo ?? false;
    const modelo = await this.buildModel(patrolId, {
      ...opciones,
      incluirAnexo,
    });

    const tenantId = modelo.tenantId;
    const cerrada = this.esRondaCerrada(modelo.estado);
    const rutaCache = tenantId ? this.rutaCache(tenantId, modelo.patrolId, incluirAnexo) : null;

    if (cerrada && rutaCache) {
      try {
        const bufferEnDisco = await readFile(rutaCache);
        if (bufferEnDisco.length > 0) {
          return {
            pdf: bufferEnDisco,
            filename: modelo.filename,
            patrolId: modelo.patrolId,
            tenantName: modelo.marca.displayName,
            compliance: modelo.compliance,
            render: { fotosIncluidas: 0, fotosOmitidas: 0, paginasAnexo: 0 },
          };
        }
      } catch {
        // Cache miss: generamos y guardamos.
      }
    }

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

  /**
   * Corre SIEMPRE, tambien cuando el informe va sin anexo (#308). Antes se
   * saltaba con `incluirAnexo:false` y el PDF que se adjunta al correo no sabia
   * siquiera que la ronda habia tenido 18 fotografias: quien lo recibia no tenia
   * como enterarse de que habia evidencia esperandolo en el panel. El anexo
   * gobierna los BYTES de las imagenes, no el HECHO de que existan, y esta
   * consulta no abre un solo archivo del volumen.
   */
  private async leerMetadatosFotos(patrolId: string): Promise<FotoRow[]> {
    return this.tenantContext.manager.query<FotoRow[]>(SQL_FOTOS_DE_LA_RONDA, [patrolId]);
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
