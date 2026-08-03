import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { randomBytes, randomUUID } from 'node:crypto';
import { QueryFailedError } from 'typeorm';

import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RulesService } from '../rules/rules.service';
import { ZONA_QUIETA, qrMatriz, qrSvg, qrTramos } from './qr-code';

/**
 * Prefijo reconocible del contenido del QR. Permite que la app descarte de
 * inmediato un QR ajeno —un cartel, una promocion pegada al lado— sin salir a
 * consultar la API.
 */
const PREFIJO_UID = 'VXQ-';

/**
 * 16 bytes de aleatoriedad. El UID NO se deriva del id del punto ni de nada
 * publico: si se pudiera derivar, cualquiera que conozca el id imprime el QR de
 * un punto ajeno y marca presencia sin pisar el recinto, que es exactamente lo
 * que la etiqueta existe para impedir.
 */
const BYTES_UID = 16;

const ALFABETO_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const MARGEN = 36;
const COLUMNAS = 3;
const FILAS = 5;

const PALETA = {
  tinta: '#111111',
  gris: '#5f6368',
  linea: '#d0d3d8',
  guia: '#c8ccd2',
  alerta: '#b02a37',
} as const;

interface PuntoRow {
  id: string;
  name: string;
  is_active: boolean;
  site_id: string;
  site_name: string;
}

interface TagRow {
  id: string;
  uid: string;
  installed_at: Date;
}

interface RecintoRow {
  id: string;
  name: string;
  branch_name: string;
  timezone: string;
  tenant_name: string;
}

interface PuntoPlanillaRow {
  id: string;
  name: string;
  kind: 'normal' | 'acceso_critico';
  uid: string | null;
  installed_at: Date | null;
}

export interface EtiquetaQr {
  readonly tagId: string;
  readonly uid: string;
  readonly shortCode: string;
  readonly created: boolean;
  readonly issuedAt: Date;
  readonly checkpoint: { readonly id: string; readonly name: string };
  readonly site: { readonly id: string; readonly name: string };
  readonly svg: string;
}

export interface EtiquetaPlanilla {
  readonly checkpointId: string;
  readonly checkpointName: string;
  readonly kind: 'normal' | 'acceso_critico';
  readonly uid: string | null;
  readonly shortCode: string | null;
  readonly issuedAt: Date | null;
  readonly svg: string | null;
}

export interface PlanillaQr {
  readonly site: {
    readonly id: string;
    readonly name: string;
    readonly branchName: string;
    readonly timezone: string;
  };
  readonly tenantName: string;
  readonly qrBackupEnabled: boolean;
  readonly issued: number;
  readonly missing: number;
  readonly labels: readonly EtiquetaPlanilla[];
}

export interface PlanillaPdf {
  readonly pdf: Buffer;
  readonly filename: string;
  readonly siteId: string;
  readonly labels: number;
  readonly missing: number;
}

@Injectable()
export class QrService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly rules: RulesService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Emite la etiqueta QR de respaldo del punto (#56). Es idempotente: si el
   * punto ya tiene una QR vigente devuelve esa. Emitir una nueva por cada
   * impresion dejaria pegadas en la pared etiquetas que ya no resuelven.
   *
   * Para rotar una etiqueta (se rayo, alguien le saco una foto) se retira la
   * vigente con DELETE /admin/tags/:tagId y despues se vuelve a emitir.
   */
  async issueForCheckpoint(checkpointId: string, actorId: string): Promise<EtiquetaQr> {
    const reglas = await this.rules.effective();
    if (!reglas.allowQrFallback) {
      throw new ConflictException('El respaldo por QR está deshabilitado en las reglas del tenant');
    }

    const puntos = await this.tenantContext.manager.query<PuntoRow[]>(
      `SELECT punto.id, punto.name, punto.is_active,
              recinto.id AS site_id, recinto.name AS site_name
       FROM checkpoints punto
       JOIN sites recinto ON recinto.id = punto.site_id
       WHERE punto.id = $1`,
      [checkpointId],
    );
    const punto = puntos[0];
    if (!punto) throw new NotFoundException('Punto de control no encontrado');
    if (!punto.is_active) throw new ConflictException('El punto de control está desactivado');

    const vigente = await this.etiquetaVigente(checkpointId);
    if (vigente) return this.armarEtiqueta(punto, vigente, false);

    let creada: TagRow | undefined;
    try {
      const filas = await this.tenantContext.manager.query<TagRow[]>(
        `INSERT INTO tags (id, tenant_id, checkpoint_id, tech, uid)
         VALUES ($1, app_tenant_id(), $2, 'qr', $3)
         RETURNING id, uid, installed_at`,
        [randomUUID(), checkpointId, this.nuevoUid()],
      );
      creada = filas[0];
    } catch (error) {
      if (error instanceof QueryFailedError && error.driverError?.code === '23505') {
        // Dos admin emitiendo a la vez: el indice tags_checkpoint_tech_uniq deja
        // pasar una sola. Se devuelve la que gano, en vez de dejar el punto con
        // dos QR vigentes de los que solo uno resuelve.
        const ganadora = await this.etiquetaVigente(checkpointId);
        if (ganadora) return this.armarEtiqueta(punto, ganadora, false);
        throw new ConflictException('No fue posible emitir la etiqueta QR. Inténtalo nuevamente.');
      }
      throw error;
    }
    if (!creada) {
      throw new ConflictException('No fue posible emitir la etiqueta QR. Inténtalo nuevamente.');
    }

    await this.registrarEmision(actorId, creada.id, punto);
    return this.armarEtiqueta(punto, creada, true);
  }

  /**
   * Datos de la planilla imprimible del recinto (#135): todos los puntos
   * ACTIVOS, cada uno con su QR vigente si lo tiene. Es de solo lectura —no
   * emite etiquetas—, asi que el punto sin etiqueta sale marcado y el panel
   * decide si llama a issueForCheckpoint por cada faltante.
   */
  async sheetForSite(siteId: string): Promise<PlanillaQr> {
    const recintos = await this.tenantContext.manager.query<RecintoRow[]>(
      `SELECT recinto.id, recinto.name, recinto.branch_name, recinto.timezone,
              tenant.display_name AS tenant_name
       FROM sites recinto
       JOIN tenants tenant ON tenant.id = recinto.tenant_id
       WHERE recinto.id = $1`,
      [siteId],
    );
    const recinto = recintos[0];
    if (!recinto) throw new NotFoundException('Recinto no encontrado');

    const puntos = await this.tenantContext.manager.query<PuntoPlanillaRow[]>(
      `SELECT punto.id, punto.name, punto.kind, etiqueta.uid, etiqueta.installed_at
       FROM checkpoints punto
       LEFT JOIN tags etiqueta
         ON etiqueta.checkpoint_id = punto.id
        AND etiqueta.tech = 'qr'
        AND etiqueta.is_active
       WHERE punto.site_id = $1 AND punto.is_active
       ORDER BY punto.suggested_order, punto.name`,
      [siteId],
    );

    const reglas = await this.rules.effective();
    const labels: EtiquetaPlanilla[] = puntos.map((punto) => ({
      checkpointId: punto.id,
      checkpointName: punto.name,
      kind: punto.kind,
      uid: punto.uid,
      shortCode: punto.uid === null ? null : codigoCorto(punto.uid),
      issuedAt: punto.installed_at,
      svg: punto.uid === null ? null : qrSvg(punto.uid),
    }));

    return {
      site: {
        id: recinto.id,
        name: recinto.name,
        branchName: recinto.branch_name,
        timezone: recinto.timezone,
      },
      tenantName: recinto.tenant_name,
      qrBackupEnabled: reglas.allowQrFallback,
      issued: labels.filter((label) => label.uid !== null).length,
      missing: labels.filter((label) => label.uid === null).length,
      labels,
    };
  }

  /** La misma planilla en PDF, en grilla para hoja adhesiva. */
  async sheetPdf(siteId: string): Promise<PlanillaPdf> {
    const planilla = await this.sheetForSite(siteId);
    const pdf = await this.renderizar((doc) => {
      this.dibujarPlanilla(doc, planilla);
    });
    return {
      pdf,
      filename: `etiquetas-qr-${siteId}.pdf`,
      siteId,
      labels: planilla.labels.length,
      missing: planilla.missing,
    };
  }

  // ------------------------------------------------------------------ datos

  private async etiquetaVigente(checkpointId: string): Promise<TagRow | undefined> {
    const filas = await this.tenantContext.manager.query<TagRow[]>(
      `SELECT id, uid, installed_at
       FROM tags
       WHERE checkpoint_id = $1 AND tech = 'qr' AND is_active`,
      [checkpointId],
    );
    return filas[0];
  }

  private nuevoUid(): string {
    return PREFIJO_UID + base32(randomBytes(BYTES_UID));
  }

  private armarEtiqueta(punto: PuntoRow, etiqueta: TagRow, created: boolean): EtiquetaQr {
    return {
      tagId: etiqueta.id,
      uid: etiqueta.uid,
      shortCode: codigoCorto(etiqueta.uid),
      created,
      issuedAt: etiqueta.installed_at,
      checkpoint: { id: punto.id, name: punto.name },
      site: { id: punto.site_id, name: punto.site_name },
      svg: qrSvg(etiqueta.uid),
    };
  }

  private async registrarEmision(actorId: string, tagId: string, punto: PuntoRow): Promise<void> {
    const actores = await this.tenantContext.manager.query<Array<{ label: string }>>(
      `SELECT (given_name || ' ' || family_name) AS label FROM users WHERE id = $1`,
      [actorId],
    );
    await this.audit.record({
      actorId,
      actorLabel: actores[0]?.label ?? 'usuario desconocido',
      action: 'etiqueta.registrada',
      entityType: 'tag',
      entityId: tagId,
      summary: `QR de respaldo emitido para ${punto.name} (${punto.site_name})`,
    });
  }

  // -------------------------------------------------------------------- pdf

  private renderizar(dibujar: (doc: PDFKit.PDFDocument) => void): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', margin: MARGEN });
      const partes: Buffer[] = [];
      doc.on('data', (parte: Buffer) => partes.push(parte));
      doc.on('end', () => resolve(Buffer.concat(partes)));
      doc.on('error', (error: Error) => reject(error));
      try {
        dibujar(doc);
        doc.end();
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private dibujarPlanilla(doc: PDFKit.PDFDocument, planilla: PlanillaQr): void {
    const anchoUtil = doc.page.width - MARGEN * 2;
    const altoEncabezado = 46;
    const altoPie = 16;
    const anchoCelda = anchoUtil / COLUMNAS;
    const altoCelda = (doc.page.height - MARGEN * 2 - altoEncabezado - altoPie) / FILAS;
    const porPagina = COLUMNAS * FILAS;

    if (planilla.labels.length === 0) {
      this.dibujarEncabezado(doc, planilla, 1, 1);
      doc.font('Helvetica').fontSize(10).fillColor(PALETA.gris)
        .text('El recinto no tiene puntos de control activos.', MARGEN, MARGEN + altoEncabezado, {
          width: anchoUtil,
        });
      this.dibujarPie(doc, planilla.site.timezone);
      return;
    }

    const paginas = Math.ceil(planilla.labels.length / porPagina);
    planilla.labels.forEach((etiqueta, indice) => {
      const posicion = indice % porPagina;
      if (posicion === 0) {
        if (indice > 0) doc.addPage();
        this.dibujarEncabezado(doc, planilla, Math.floor(indice / porPagina) + 1, paginas);
      }
      this.dibujarEtiqueta(
        doc,
        etiqueta,
        planilla,
        MARGEN + (posicion % COLUMNAS) * anchoCelda,
        MARGEN + altoEncabezado + Math.floor(posicion / COLUMNAS) * altoCelda,
        anchoCelda,
        altoCelda,
      );
      if (posicion === porPagina - 1 || indice === planilla.labels.length - 1) {
        this.dibujarPie(doc, planilla.site.timezone);
      }
    });
  }

  private dibujarEncabezado(
    doc: PDFKit.PDFDocument,
    planilla: PlanillaQr,
    pagina: number,
    paginas: number,
  ): void {
    const ancho = doc.page.width - MARGEN * 2;
    doc.font('Helvetica-Bold').fontSize(13).fillColor(PALETA.tinta)
      .text(planilla.tenantName, MARGEN, MARGEN, { width: ancho, lineBreak: false });
    doc.font('Helvetica').fontSize(9.5).fillColor(PALETA.gris)
      .text(
        `Etiquetas QR de respaldo · ${planilla.site.name} — ${planilla.site.branchName}`,
        MARGEN,
        MARGEN + 17,
        { width: ancho - 70, lineBreak: false },
      );
    doc.fontSize(8).text(`Página ${pagina}/${paginas}`, MARGEN + ancho - 70, MARGEN + 18, {
      width: 70,
      align: 'right',
      lineBreak: false,
    });
    const y = MARGEN + 34;
    doc.moveTo(MARGEN, y).lineTo(MARGEN + ancho, y).lineWidth(0.8).stroke(PALETA.linea);
  }

  private dibujarEtiqueta(
    doc: PDFKit.PDFDocument,
    etiqueta: EtiquetaPlanilla,
    planilla: PlanillaQr,
    x: number,
    y: number,
    ancho: number,
    alto: number,
  ): void {
    // Guia de corte punteada: la hoja adhesiva se corta a mano.
    doc.dash(2, { space: 2 })
      .roundedRect(x + 3, y + 3, ancho - 6, alto - 6, 4)
      .lineWidth(0.5)
      .stroke(PALETA.guia);
    doc.undash();

    const relleno = 10;
    const ladoQr = Math.min(alto - relleno * 2, ancho * 0.5);
    const xQr = x + relleno;
    const yQr = y + (alto - ladoQr) / 2;
    const xTexto = xQr + ladoQr + 8;
    const anchoTexto = x + ancho - relleno - xTexto;

    if (etiqueta.uid === null) {
      doc.rect(xQr, yQr, ladoQr, ladoQr).lineWidth(0.6).stroke(PALETA.linea);
      doc.font('Helvetica').fontSize(7).fillColor(PALETA.alerta)
        .text('sin\netiqueta', xQr, yQr + ladoQr / 2 - 10, { width: ladoQr, align: 'center' });
    } else {
      this.dibujarQr(doc, etiqueta.uid, xQr, yQr, ladoQr);
    }

    const yTexto = yQr + 2;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(PALETA.tinta)
      .text(recortar(etiqueta.checkpointName, 38), xTexto, yTexto, {
        width: anchoTexto,
        height: 22,
      });
    doc.font('Helvetica').fontSize(7.5).fillColor(PALETA.gris)
      .text(recortar(planilla.site.name, 34), xTexto, yTexto + 24, {
        width: anchoTexto,
        lineBreak: false,
      });
    doc.fontSize(7).text(recortar(planilla.site.branchName, 34), xTexto, yTexto + 34, {
      width: anchoTexto,
      lineBreak: false,
    });
    if (etiqueta.kind === 'acceso_critico') {
      doc.fontSize(6.5).fillColor(PALETA.alerta)
        .text('ACCESO CRÍTICO', xTexto, yTexto + 45, { width: anchoTexto, lineBreak: false });
    }
    // Solo el sufijo del UID: alcanza para que el instalador empareje etiqueta
    // con punto, y no deja el UID completo escrito en claro sobre la pared.
    doc.font('Helvetica').fontSize(6.5).fillColor(PALETA.gris)
      .text(
        etiqueta.shortCode === null ? 'emitir desde el panel' : `··${etiqueta.shortCode}`,
        xTexto,
        yQr + ladoQr - 9,
        { width: anchoTexto, lineBreak: false },
      );
  }

  private dibujarQr(
    doc: PDFKit.PDFDocument,
    uid: string,
    x: number,
    y: number,
    lado: number,
  ): void {
    const matriz = qrMatriz(uid);
    const modulo = lado / (matriz.size + ZONA_QUIETA * 2);
    // La zona quieta es blanca y obligatoria: sobre papel de color o pegado
    // encima de otra etiqueta, sin ella el lector no encuentra el simbolo.
    doc.rect(x, y, lado, lado).fill('#ffffff');
    for (const tramo of qrTramos(matriz)) {
      doc
        .rect(x + tramo.x * modulo, y + tramo.y * modulo, tramo.largo * modulo, modulo)
        .fill('#000000');
    }
  }

  private dibujarPie(doc: PDFKit.PDFDocument, timezone: string): void {
    const ancho = doc.page.width - MARGEN * 2;
    doc.font('Helvetica').fontSize(7).fillColor(PALETA.gris)
      .text(
        'El QR es respaldo del NFC: el escaneo queda registrado como tal. ' +
          `Generado el ${formatearFechaHora(new Date(), timezone)}`,
        MARGEN,
        doc.page.height - MARGEN - 8,
        { width: ancho, lineBreak: false },
      );
  }
}

// ------------------------------------------------------------------ utilitarios

function base32(bytes: Buffer): string {
  let bits = 0;
  let acumulado = 0;
  let salida = '';
  for (const byte of bytes) {
    acumulado = (acumulado << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += ALFABETO_BASE32.charAt((acumulado >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) salida += ALFABETO_BASE32.charAt((acumulado << (5 - bits)) & 31);
  return salida;
}

function codigoCorto(uid: string): string {
  return uid.slice(-6);
}

function recortar(texto: string, largo: number): string {
  return texto.length > largo ? `${texto.slice(0, largo - 1)}…` : texto;
}

function formatearFechaHora(fecha: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('es-CL', {
      timeZone: timezone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(fecha);
  } catch {
    return fecha.toISOString();
  }
}
