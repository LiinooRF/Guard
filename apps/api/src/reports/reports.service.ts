import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import PDFDocument from 'pdfkit';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { BrandingService } from '../branding/branding.service';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RulesService } from '../rules/rules.service';
import {
  ESTADOS_RONDA,
  MARGEN,
  PALETA,
  anchoUtil,
  asegurarEspacio,
  claveFecha,
  dibujarEncabezadoMarca,
  dibujarFicha,
  dibujarPie,
  dibujarTabla,
  dibujarTituloSeccion,
  formatearDiaMes,
  formatearFecha,
  formatearFechaHora,
  recortar,
} from './pdf-primitivas';

/**
 * Informes agregados por sucursal.
 *
 * El informe de UNA ronda vive en PatrolReportService (#85): tiene anexo
 * fotografico, se genera por streaming y lo consume tambien la cola del envio
 * automatico. Aca queda el resumen del periodo, que es tabular y chico.
 */

interface SitioRow {
  tenant_name: string;
  site_name: string;
  branch_name: string;
  timezone: string;
}

interface RondaPeriodoRow {
  id: string;
  status: string;
  scheduled_start_at: Date;
  closed_at: Date | null;
  compliance_pct: string | null;
  route_name: string;
  guard_name: string;
}

interface SemanaRow {
  week_start: Date;
  avg_pct: number;
  patrol_count: number;
}

interface RutaRow {
  route_name: string;
  avg_pct: number;
  patrol_count: number;
}

export interface SiteSummaryReport {
  readonly pdf: Buffer;
  readonly filename: string;
  readonly siteId: string;
  readonly from: Date;
  readonly to: Date;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly rules: RulesService,
    private readonly branding: BrandingService,
  ) {}

  /**
   * Resumen por sucursal para un periodo: cumplimiento promedio por semana y
   * por ruta (barras dibujadas con primitivas, sin librerias de charts) mas la
   * tabla de rondas. Sin `from`/`to` cubre los ultimos 30 dias.
   */
  async buildSiteSummary(
    siteId: string,
    from?: string,
    to?: string,
    requester: Pick<AuthenticatedUser, 'sub' | 'role'> | null = null,
  ): Promise<SiteSummaryReport> {
    const hasta = to ? new Date(to) : new Date();
    const desde = from ? new Date(from) : new Date(hasta.getTime() - 30 * 24 * 3_600_000);
    if (Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime())) {
      throw new BadRequestException('El rango de fechas no es valido');
    }
    if (desde >= hasta) {
      throw new BadRequestException('`from` debe ser anterior a `to`');
    }

    const sitios = await this.tenantContext.manager.query<SitioRow[]>(
      `
        SELECT
          t.display_name AS tenant_name,
          s.name AS site_name,
          s.branch_name,
          s.timezone
        FROM sites s
        JOIN tenants t ON t.id = s.tenant_id
        WHERE s.id = $1
      `,
      [siteId],
    );
    const sitio = sitios[0];
    if (!sitio) throw new NotFoundException('La sucursal no existe');
    await this.verificarAlcance(siteId, requester);

    const rondas = await this.tenantContext.manager.query<RondaPeriodoRow[]>(
      `
        SELECT
          p.id,
          p.status,
          p.scheduled_start_at,
          p.closed_at,
          p.compliance_pct,
          r.name AS route_name,
          (u.given_name || ' ' || u.family_name) AS guard_name
        FROM patrols p
        JOIN routes r ON r.tenant_id = p.tenant_id AND r.id = p.route_id
        JOIN users u ON u.id = p.guard_id
        WHERE p.site_id = $1
          AND p.scheduled_start_at >= $2
          AND p.scheduled_start_at < $3
        ORDER BY p.scheduled_start_at
      `,
      [siteId, desde, hasta],
    );

    const semanas = await this.tenantContext.manager.query<SemanaRow[]>(
      `
        SELECT
          date_trunc('week', p.scheduled_start_at) AS week_start,
          round(avg(p.compliance_pct))::int AS avg_pct,
          count(*)::int AS patrol_count
        FROM patrols p
        WHERE p.site_id = $1
          AND p.compliance_pct IS NOT NULL
          AND p.scheduled_start_at >= $2
          AND p.scheduled_start_at < $3
        GROUP BY 1
        ORDER BY 1
      `,
      [siteId, desde, hasta],
    );

    const rutas = await this.tenantContext.manager.query<RutaRow[]>(
      `
        SELECT
          r.name AS route_name,
          round(avg(p.compliance_pct))::int AS avg_pct,
          count(*)::int AS patrol_count
        FROM patrols p
        JOIN routes r ON r.tenant_id = p.tenant_id AND r.id = p.route_id
        WHERE p.site_id = $1
          AND p.compliance_pct IS NOT NULL
          AND p.scheduled_start_at >= $2
          AND p.scheduled_start_at < $3
        GROUP BY r.name
        ORDER BY r.name
      `,
      [siteId, desde, hasta],
    );

    const reglas = await this.rules.effective();
    // La marca del tenant manda sobre el nombre legal, igual que en el informe
    // de ronda: los dos documentos los ve el mismo cliente final.
    const marca = await this.branding.forDocuments();
    const pdf = await this.renderizar((doc) => {
      this.dibujarResumenSitio(
        doc,
        {
          displayName: marca.displayName,
          logoUri: marca.logoUri,
          primaryColor: marca.primaryColor,
          mailFooter: marca.mailFooter,
        },
        sitio,
        rondas,
        semanas,
        rutas,
        desde,
        hasta,
        reglas.complianceThreshold,
      );
    });

    return {
      pdf,
      filename: `resumen-sucursal-${siteId}-${claveFecha(desde)}-${claveFecha(hasta)}.pdf`,
      siteId,
      from: desde,
      to: hasta,
    };
  }

  private async verificarAlcance(
    siteId: string,
    requester: Pick<AuthenticatedUser, 'sub' | 'role'> | null,
  ): Promise<void> {
    if (requester === null || requester.role !== 'SUPERVISOR') return;
    const asignacion = await this.tenantContext.manager.query<Array<{ present: boolean }>>(
      `SELECT true AS present
       FROM supervisor_sites
       WHERE site_id = $1 AND supervisor_id = $2`,
      [siteId, requester.sub],
    );
    if (!asignacion.length) throw new ForbiddenException('No tienes este recinto asignado');
  }

  // ------------------------------------------------------------- render base

  /**
   * El resumen por sucursal es tabular y chico (una hoja o dos, sin imagenes):
   * se arma en memoria sin problema. El informe de ronda, que si puede traer
   * decenas de fotos, va por streaming — ver patrol-report.renderer.ts.
   */
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

  // --------------------------------------------------------- resumen por sitio

  private dibujarResumenSitio(
    doc: PDFKit.PDFDocument,
    marca: {
      displayName: string;
      logoUri: string | null;
      primaryColor: string;
      mailFooter: string | null;
    },
    sitio: SitioRow,
    rondas: readonly RondaPeriodoRow[],
    semanas: readonly SemanaRow[],
    rutas: readonly RutaRow[],
    desde: Date,
    hasta: Date,
    umbral: number,
  ): void {
    const tz = sitio.timezone;
    // El logo va en null: resolverlo es asincrono (disco o data URI) y este
    // informe se dibuja sincronico. Queda pendiente unificarlo con el camino
    // del informe de ronda.
    dibujarEncabezadoMarca(doc, marca, 'Resumen de cumplimiento por sucursal', null);

    const cerradas = rondas.filter((r) => r.compliance_pct !== null);
    const promedio =
      cerradas.length === 0
        ? null
        : Math.round(
            cerradas.reduce((suma, r) => suma + Number(r.compliance_pct), 0) / cerradas.length,
          );

    dibujarFicha(doc, [
      ['Recinto', sitio.site_name],
      ['Sucursal', sitio.branch_name],
      ['Periodo', `${formatearFecha(desde, tz)} — ${formatearFecha(hasta, tz)}`],
      ['Rondas en el periodo', String(rondas.length)],
      ['Rondas cerradas', String(cerradas.length)],
      [
        'Cumplimiento promedio',
        promedio === null ? 'Sin rondas cerradas' : `${promedio}% (umbral ${umbral}%)`,
      ],
    ]);

    dibujarTituloSeccion(doc, 'Cumplimiento promedio por semana');
    this.dibujarBarrasVerticales(
      doc,
      semanas.map((s) => ({
        etiqueta: formatearDiaMes(s.week_start, tz),
        valor: s.avg_pct,
      })),
      umbral,
    );

    dibujarTituloSeccion(doc, 'Cumplimiento promedio por ruta');
    this.dibujarBarrasHorizontales(
      doc,
      rutas.map((r) => ({
        etiqueta: `${r.route_name} (${r.patrol_count})`,
        valor: r.avg_pct,
      })),
      umbral,
    );

    dibujarTituloSeccion(doc, 'Rondas del periodo');
    if (rondas.length === 0) {
      doc.font('Helvetica').fontSize(9).fillColor(PALETA.gris)
        .text('Sin rondas en el periodo.', doc.page.margins.left, doc.y);
      doc.y += 6;
    } else {
      dibujarTabla(
        doc,
        [
          { titulo: 'Fecha', ancho: 100 },
          { titulo: 'Ruta', ancho: 140 },
          { titulo: 'Guardia', ancho: 125 },
          { titulo: 'Estado', ancho: 80 },
          { titulo: 'Cumplimiento', ancho: 70, alinear: 'right' },
        ],
        rondas.map((ronda) => {
          const pct =
            ronda.compliance_pct === null ? null : Math.round(Number(ronda.compliance_pct));
          return [
            { texto: formatearFechaHora(ronda.scheduled_start_at, tz) },
            { texto: recortar(ronda.route_name, 32) },
            { texto: recortar(ronda.guard_name, 28) },
            { texto: ESTADOS_RONDA[ronda.status] ?? ronda.status },
            pct === null
              ? { texto: '—', color: PALETA.gris }
              : {
                  texto: `${pct}%`,
                  color: pct >= umbral ? PALETA.ok : PALETA.alerta,
                  negrita: true,
                },
          ];
        }),
      );
    }

    dibujarPie(doc, tz, marca.mailFooter);
  }

  private dibujarBarrasVerticales(
    doc: PDFKit.PDFDocument,
    datos: ReadonlyArray<{ etiqueta: string; valor: number }>,
    umbral: number,
  ): void {
    const x0 = doc.page.margins.left;
    if (datos.length === 0) {
      doc.font('Helvetica').fontSize(9).fillColor(PALETA.gris)
        .text('Sin rondas cerradas en el periodo.', x0, doc.y);
      doc.y += 10;
      return;
    }

    const ancho = anchoUtil(doc);
    const alto = 110;
    asegurarEspacio(doc, alto + 40);
    const y0 = doc.y + 12;
    const base = y0 + alto;

    doc.moveTo(x0, base).lineTo(x0 + ancho, base).lineWidth(0.8).stroke(PALETA.gris);
    const yUmbral = base - (umbral / 100) * alto;
    doc.dash(3, { space: 3 }).moveTo(x0, yUmbral).lineTo(x0 + ancho, yUmbral)
      .lineWidth(0.6).stroke(PALETA.gris);
    doc.undash();
    doc.font('Helvetica').fontSize(7).fillColor(PALETA.gris)
      .text(`${umbral}%`, x0 + ancho - 22, yUmbral - 9, { lineBreak: false });

    const cupo = ancho / datos.length;
    const anchoBarra = Math.max(6, Math.min(46, cupo * 0.62));
    datos.forEach((dato, indice) => {
      const valor = Math.max(0, Math.min(100, dato.valor));
      const bx = x0 + indice * cupo + (cupo - anchoBarra) / 2;
      const altoBarra = Math.max(1, (valor / 100) * alto);
      doc.rect(bx, base - altoBarra, anchoBarra, altoBarra)
        .fill(valor >= umbral ? PALETA.ok : PALETA.alerta);
      doc.font('Helvetica').fontSize(7).fillColor(PALETA.tinta)
        .text(`${valor}%`, bx - 6, base - altoBarra - 10, {
          width: anchoBarra + 12,
          align: 'center',
          lineBreak: false,
        });
      doc.fillColor(PALETA.gris)
        .text(dato.etiqueta, bx - 8, base + 4, {
          width: anchoBarra + 16,
          align: 'center',
          lineBreak: false,
        });
    });

    doc.x = x0;
    doc.y = base + 20;
  }

  private dibujarBarrasHorizontales(
    doc: PDFKit.PDFDocument,
    datos: ReadonlyArray<{ etiqueta: string; valor: number }>,
    umbral: number,
  ): void {
    const x0 = doc.page.margins.left;
    if (datos.length === 0) {
      doc.font('Helvetica').fontSize(9).fillColor(PALETA.gris)
        .text('Sin rondas cerradas en el periodo.', x0, doc.y);
      doc.y += 10;
      return;
    }

    const anchoEtiqueta = 170;
    const anchoValor = 40;
    const anchoBarra = anchoUtil(doc) - anchoEtiqueta - anchoValor;
    const altoFila = 18;

    for (const dato of datos) {
      asegurarEspacio(doc, altoFila);
      const y = doc.y;
      const valor = Math.max(0, Math.min(100, dato.valor));
      doc.font('Helvetica').fontSize(8.5).fillColor(PALETA.tinta)
        .text(recortar(dato.etiqueta, 38), x0, y + 3, {
          width: anchoEtiqueta - 8,
          lineBreak: false,
        });
      const bx = x0 + anchoEtiqueta;
      doc.roundedRect(bx, y + 3, anchoBarra, 9, 2).fill(PALETA.fondoBarra);
      const relleno = (valor / 100) * anchoBarra;
      if (relleno > 0) {
        doc.roundedRect(bx, y + 3, relleno, 9, 2)
          .fill(valor >= umbral ? PALETA.ok : PALETA.alerta);
      }
      doc.font('Helvetica-Bold').fontSize(8.5)
        .fillColor(valor >= umbral ? PALETA.ok : PALETA.alerta)
        .text(`${valor}%`, bx + anchoBarra + 6, y + 3, {
          width: anchoValor - 6,
          align: 'right',
          lineBreak: false,
        });
      doc.y = y + altoFila;
    }

    doc.x = x0;
    doc.y += 8;
  }
}
