import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import {
  computeCompliance,
  type ComplianceResult,
  type ScanAnomaly,
} from '@voxia/shared';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RulesService } from '../rules/rules.service';

const MARGEN = 40;

const PALETA = {
  tinta: '#111111',
  gris: '#5f6368',
  linea: '#d0d3d8',
  fondoBarra: '#e8eaed',
  zebra: '#f4f5f7',
  ok: '#1e7e34',
  alerta: '#b02a37',
} as const;

const ESTADOS: Record<string, string> = {
  pendiente: 'Pendiente',
  en_curso: 'En curso',
  completada: 'Completada',
  incompleta: 'Incompleta',
  vencida: 'Vencida',
};

interface EncabezadoRondaRow {
  id: string;
  status: string;
  scheduled_start_at: Date;
  scheduled_end_at: Date;
  started_at: Date | null;
  closed_at: Date | null;
  compliance_pct: string | null;
  tenant_name: string;
  site_name: string;
  branch_name: string;
  timezone: string;
  route_name: string;
  guard_name: string;
}

interface PuntoEsperadoRow {
  position: string;
  id: string;
  name: string;
  kind: string;
  is_closing_point: boolean;
}

interface ScanRow {
  checkpoint_id: string;
  method: string;
  scanned_at_server: Date;
  scanned_at_device: Date | null;
  anomalies: ScanAnomaly[];
}

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

interface Columna {
  titulo: string;
  ancho: number;
  alinear?: 'left' | 'right' | 'center';
}

interface Celda {
  texto: string;
  color?: string;
  negrita?: boolean;
}

export interface PatrolReport {
  readonly pdf: Buffer;
  readonly filename: string;
  readonly patrolId: string;
  readonly tenantName: string;
  readonly compliance: ComplianceResult;
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
  ) {}

  /**
   * Informe de UNA ronda, en memoria. Es la promesa fundacional del producto
   * (#17): al escanear el punto de cierre este PDF se genera y se envia solo.
   * El cumplimiento del encabezado se calcula con computeCompliance() sobre los
   * mismos datos que dibuja la tabla: no puede desincronizarse de ella.
   */
  async buildPatrolReport(patrolId: string): Promise<PatrolReport> {
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
          t.display_name AS tenant_name,
          s.name AS site_name,
          s.branch_name,
          s.timezone,
          r.name AS route_name,
          (u.given_name || ' ' || u.family_name) AS guard_name
        FROM patrols p
        JOIN tenants t ON t.id = p.tenant_id
        JOIN sites s ON s.tenant_id = p.tenant_id AND s.id = p.site_id
        JOIN routes r ON r.tenant_id = p.tenant_id AND r.id = p.route_id
        JOIN users u ON u.id = p.guard_id
        WHERE p.id = $1
      `,
      [patrolId],
    );
    const ronda = encabezados[0];
    if (!ronda) throw new NotFoundException('La ronda no existe');

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

    const reglas = await this.rules.effective();
    const compliance = computeCompliance(
      puntos.map((p) => p.id),
      scans.map((s) => ({ checkpointId: s.checkpoint_id, anomalies: s.anomalies })),
      reglas.complianceThreshold,
    );

    const primeraLectura = new Map<string, ScanRow>();
    for (const scan of scans) {
      if (!primeraLectura.has(scan.checkpoint_id)) primeraLectura.set(scan.checkpoint_id, scan);
    }

    const pdf = await this.renderizar((doc) => {
      this.dibujarInformeRonda(
        doc,
        ronda,
        puntos,
        primeraLectura,
        compliance,
        reglas.complianceThreshold,
      );
    });

    return {
      pdf,
      filename: `informe-ronda-${ronda.id}.pdf`,
      patrolId: ronda.id,
      tenantName: ronda.tenant_name,
      compliance,
    };
  }

  /**
   * Resumen por sucursal para un periodo: cumplimiento promedio por semana y
   * por ruta (barras dibujadas con primitivas, sin librerias de charts) mas la
   * tabla de rondas. Sin `from`/`to` cubre los ultimos 30 dias.
   */
  async buildSiteSummary(siteId: string, from?: string, to?: string): Promise<SiteSummaryReport> {
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
    const pdf = await this.renderizar((doc) => {
      this.dibujarResumenSitio(
        doc,
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

  // ------------------------------------------------------------- render base

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

  private anchoUtil(doc: PDFKit.PDFDocument): number {
    return doc.page.width - doc.page.margins.left - doc.page.margins.right;
  }

  private limiteInferior(doc: PDFKit.PDFDocument): number {
    return doc.page.height - doc.page.margins.bottom;
  }

  private asegurarEspacio(doc: PDFKit.PDFDocument, alto: number): void {
    if (doc.y + alto > this.limiteInferior(doc)) doc.addPage();
  }

  // ---------------------------------------------------------- informe de ronda

  private dibujarInformeRonda(
    doc: PDFKit.PDFDocument,
    ronda: EncabezadoRondaRow,
    puntos: readonly PuntoEsperadoRow[],
    lecturas: ReadonlyMap<string, ScanRow>,
    compliance: ComplianceResult,
    umbral: number,
  ): void {
    const tz = ronda.timezone;
    this.dibujarEncabezado(doc, ronda.tenant_name, 'Informe de ronda');

    this.dibujarFicha(doc, [
      ['Recinto', ronda.site_name],
      ['Sucursal', ronda.branch_name],
      ['Ruta', ronda.route_name],
      ['Guardia', ronda.guard_name],
      [
        'Ventana horaria',
        `${formatearFechaHora(ronda.scheduled_start_at, tz)} — ${formatearFechaHora(ronda.scheduled_end_at, tz)}`,
      ],
      ['Inicio', formatearFechaHora(ronda.started_at, tz)],
      ['Cierre', formatearFechaHora(ronda.closed_at, tz)],
      ['Estado', ESTADOS[ronda.status] ?? ronda.status],
    ]);

    this.dibujarCumplimiento(doc, compliance, umbral);

    this.dibujarTituloSeccion(doc, 'Puntos de la ronda');
    this.dibujarTabla(
      doc,
      [
        { titulo: 'Nº', ancho: 26, alinear: 'right' },
        { titulo: 'Punto', ancho: 189 },
        { titulo: 'Estado', ancho: 80 },
        { titulo: 'Hora (servidor)', ancho: 110 },
        { titulo: 'Anomalías', ancho: 110 },
      ],
      puntos.map((punto, indice) => {
        const lectura = lecturas.get(punto.id);
        const nombre = punto.is_closing_point ? `${punto.name} (cierre)` : punto.name;
        return [
          { texto: String(indice + 1) },
          { texto: recortar(nombre, 44) },
          lectura
            ? { texto: 'Escaneado', color: PALETA.ok }
            : { texto: 'Sin escanear', color: PALETA.alerta, negrita: true },
          { texto: lectura ? formatearFechaHora(lectura.scanned_at_server, tz) : '—' },
          {
            texto: lectura && lectura.anomalies.length > 0
              ? recortar(lectura.anomalies.map(etiquetaAnomalia).join(', '), 30)
              : '—',
            ...(lectura && lectura.anomalies.length > 0 ? { color: PALETA.alerta } : {}),
          },
        ];
      }),
    );

    if (compliance.missedCheckpointIds.length > 0) {
      const faltantes = new Set(compliance.missedCheckpointIds);
      this.dibujarTituloSeccion(
        doc,
        `Puntos sin escanear (${compliance.missedCheckpointIds.length})`,
        PALETA.alerta,
      );
      doc.font('Helvetica').fontSize(9).fillColor(PALETA.tinta);
      for (const punto of puntos.filter((p) => faltantes.has(p.id))) {
        this.asegurarEspacio(doc, 14);
        doc.text(`•  ${punto.name}`, doc.page.margins.left + 6, doc.y, {
          width: this.anchoUtil(doc) - 12,
        });
      }
      doc.y += 4;
    }

    this.dibujarPie(doc, tz);
  }

  // --------------------------------------------------------- resumen por sitio

  private dibujarResumenSitio(
    doc: PDFKit.PDFDocument,
    sitio: SitioRow,
    rondas: readonly RondaPeriodoRow[],
    semanas: readonly SemanaRow[],
    rutas: readonly RutaRow[],
    desde: Date,
    hasta: Date,
    umbral: number,
  ): void {
    const tz = sitio.timezone;
    this.dibujarEncabezado(doc, sitio.tenant_name, 'Resumen de cumplimiento por sucursal');

    const cerradas = rondas.filter((r) => r.compliance_pct !== null);
    const promedio =
      cerradas.length === 0
        ? null
        : Math.round(
            cerradas.reduce((suma, r) => suma + Number(r.compliance_pct), 0) / cerradas.length,
          );

    this.dibujarFicha(doc, [
      ['Recinto', sitio.site_name],
      ['Sucursal', sitio.branch_name],
      [
        'Periodo',
        `${formatearFecha(desde, tz)} — ${formatearFecha(hasta, tz)}`,
      ],
      ['Rondas en el periodo', String(rondas.length)],
      ['Rondas cerradas', String(cerradas.length)],
      [
        'Cumplimiento promedio',
        promedio === null ? 'Sin rondas cerradas' : `${promedio}% (umbral ${umbral}%)`,
      ],
    ]);

    this.dibujarTituloSeccion(doc, 'Cumplimiento promedio por semana');
    this.dibujarBarrasVerticales(
      doc,
      semanas.map((s) => ({
        etiqueta: formatearDiaMes(s.week_start, tz),
        valor: s.avg_pct,
      })),
      umbral,
    );

    this.dibujarTituloSeccion(doc, 'Cumplimiento promedio por ruta');
    this.dibujarBarrasHorizontales(
      doc,
      rutas.map((r) => ({
        etiqueta: `${r.route_name} (${r.patrol_count})`,
        valor: r.avg_pct,
      })),
      umbral,
    );

    this.dibujarTituloSeccion(doc, 'Rondas del periodo');
    if (rondas.length === 0) {
      doc.font('Helvetica').fontSize(9).fillColor(PALETA.gris)
        .text('Sin rondas en el periodo.', doc.page.margins.left, doc.y);
      doc.y += 6;
    } else {
      this.dibujarTabla(
        doc,
        [
          { titulo: 'Fecha', ancho: 100 },
          { titulo: 'Ruta', ancho: 140 },
          { titulo: 'Guardia', ancho: 125 },
          { titulo: 'Estado', ancho: 80 },
          { titulo: 'Cumplimiento', ancho: 70, alinear: 'right' },
        ],
        rondas.map((ronda) => {
          const pct = ronda.compliance_pct === null ? null : Math.round(Number(ronda.compliance_pct));
          return [
            { texto: formatearFechaHora(ronda.scheduled_start_at, tz) },
            { texto: recortar(ronda.route_name, 32) },
            { texto: recortar(ronda.guard_name, 28) },
            { texto: ESTADOS[ronda.status] ?? ronda.status },
            pct === null
              ? { texto: '—', color: PALETA.gris }
              : { texto: `${pct}%`, color: pct >= umbral ? PALETA.ok : PALETA.alerta, negrita: true },
          ];
        }),
      );
    }

    this.dibujarPie(doc, tz);
  }

  // ------------------------------------------------------------- componentes

  private dibujarEncabezado(doc: PDFKit.PDFDocument, tenantName: string, titulo: string): void {
    const x = doc.page.margins.left;
    // Reservado para el logo white-label (#19): cuando el tenant tenga logo,
    // va aqui con doc.image(logo, x, doc.page.margins.top, { fit: [120, 36] })
    // y el nombre se desplaza a la derecha del logo.
    doc.font('Helvetica-Bold').fontSize(16).fillColor(PALETA.tinta)
      .text(tenantName, x, doc.page.margins.top, { width: this.anchoUtil(doc), lineBreak: false });
    doc.font('Helvetica').fontSize(11).fillColor(PALETA.gris)
      .text(titulo, x, doc.y + 3, { width: this.anchoUtil(doc), lineBreak: false });
    const y = doc.y + 10;
    doc.moveTo(x, y).lineTo(x + this.anchoUtil(doc), y).lineWidth(1).stroke(PALETA.linea);
    doc.y = y + 12;
    doc.x = x;
  }

  private dibujarFicha(doc: PDFKit.PDFDocument, filas: ReadonlyArray<readonly [string, string]>): void {
    const x = doc.page.margins.left;
    const anchoEtiqueta = 120;
    for (const [etiqueta, valor] of filas) {
      this.asegurarEspacio(doc, 16);
      const y = doc.y;
      doc.font('Helvetica-Bold').fontSize(8).fillColor(PALETA.gris)
        .text(etiqueta.toUpperCase(), x, y + 1, { width: anchoEtiqueta, lineBreak: false });
      doc.font('Helvetica').fontSize(10).fillColor(PALETA.tinta)
        .text(valor, x + anchoEtiqueta + 10, y, {
          width: this.anchoUtil(doc) - anchoEtiqueta - 10,
          lineBreak: false,
        });
      doc.y = y + 16;
    }
    doc.x = x;
    doc.y += 8;
  }

  private dibujarCumplimiento(
    doc: PDFKit.PDFDocument,
    compliance: ComplianceResult,
    umbral: number,
  ): void {
    this.asegurarEspacio(doc, 110);
    const x = doc.page.margins.left;
    const color = compliance.pct >= umbral ? PALETA.ok : PALETA.alerta;
    const y = doc.y;

    doc.font('Helvetica-Bold').fontSize(8).fillColor(PALETA.gris)
      .text('CUMPLIMIENTO', x, y, { lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(42).fillColor(color)
      .text(`${compliance.pct}%`, x, y + 10, { lineBreak: false });

    const xDetalle = x + 160;
    doc.font('Helvetica').fontSize(10).fillColor(PALETA.tinta)
      .text(
        `${compliance.scanned} de ${compliance.expected} puntos escaneados`,
        xDetalle,
        y + 18,
        { lineBreak: false },
      );
    doc.fontSize(9).fillColor(PALETA.gris)
      .text(`Umbral configurado: ${umbral}%`, xDetalle, y + 33, { lineBreak: false });
    if (compliance.scanned > compliance.clean) {
      doc.fillColor(PALETA.alerta)
        .text(
          `${compliance.scanned - compliance.clean} punto(s) con anomalías marcadas`,
          xDetalle,
          y + 47,
          { lineBreak: false },
        );
    }

    this.dibujarBarra(doc, x, y + 66, this.anchoUtil(doc), compliance.pct, umbral);
    doc.x = x;
    doc.y = y + 100;
  }

  private dibujarBarra(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    ancho: number,
    pct: number,
    umbral: number,
  ): void {
    const alto = 12;
    doc.roundedRect(x, y, ancho, alto, 3).fill(PALETA.fondoBarra);
    const relleno = (Math.max(0, Math.min(100, pct)) / 100) * ancho;
    if (relleno > 0) {
      doc.roundedRect(x, y, relleno, alto, 3).fill(pct >= umbral ? PALETA.ok : PALETA.alerta);
    }
    const xUmbral = x + (Math.max(0, Math.min(100, umbral)) / 100) * ancho;
    doc.moveTo(xUmbral, y - 3).lineTo(xUmbral, y + alto + 3).lineWidth(1).stroke(PALETA.tinta);
    doc.font('Helvetica').fontSize(7).fillColor(PALETA.gris)
      .text(`umbral ${umbral}%`, Math.min(xUmbral - 20, x + ancho - 50), y + alto + 5, {
        lineBreak: false,
      });
  }

  private dibujarTituloSeccion(doc: PDFKit.PDFDocument, texto: string, color?: string): void {
    this.asegurarEspacio(doc, 40);
    const x = doc.page.margins.left;
    doc.y += 6;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(color ?? PALETA.tinta)
      .text(texto, x, doc.y, { width: this.anchoUtil(doc), lineBreak: false });
    doc.y += 18;
    doc.x = x;
  }

  private dibujarTabla(
    doc: PDFKit.PDFDocument,
    columnas: readonly Columna[],
    filas: ReadonlyArray<readonly Celda[]>,
  ): void {
    const x0 = doc.page.margins.left;
    const anchoTotal = columnas.reduce((suma, col) => suma + col.ancho, 0);
    const altoFila = 17;
    let y = doc.y;

    const cabecera = () => {
      doc.font('Helvetica-Bold').fontSize(7.5).fillColor(PALETA.gris);
      let cx = x0;
      for (const col of columnas) {
        doc.text(col.titulo.toUpperCase(), cx + 3, y + 4, {
          width: col.ancho - 6,
          align: col.alinear ?? 'left',
          lineBreak: false,
        });
        cx += col.ancho;
      }
      y += altoFila;
      doc.moveTo(x0, y).lineTo(x0 + anchoTotal, y).lineWidth(0.8).stroke(PALETA.gris);
    };

    cabecera();
    filas.forEach((fila, indice) => {
      if (y + altoFila > this.limiteInferior(doc)) {
        doc.addPage();
        y = doc.page.margins.top;
        cabecera();
      }
      if (indice % 2 === 1) {
        doc.rect(x0, y, anchoTotal, altoFila).fill(PALETA.zebra);
      }
      let cx = x0;
      fila.forEach((celda, j) => {
        const col = columnas[j]!;
        doc.font(celda.negrita ? 'Helvetica-Bold' : 'Helvetica').fontSize(8.5)
          .fillColor(celda.color ?? PALETA.tinta)
          .text(celda.texto, cx + 3, y + 4, {
            width: col.ancho - 6,
            align: col.alinear ?? 'left',
            lineBreak: false,
          });
        cx += col.ancho;
      });
      y += altoFila;
      doc.moveTo(x0, y).lineTo(x0 + anchoTotal, y).lineWidth(0.4).stroke(PALETA.linea);
    });

    doc.x = x0;
    doc.y = y + 8;
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

    const ancho = this.anchoUtil(doc);
    const alto = 110;
    this.asegurarEspacio(doc, alto + 40);
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
    const anchoBarra = this.anchoUtil(doc) - anchoEtiqueta - anchoValor;
    const altoFila = 18;

    for (const dato of datos) {
      this.asegurarEspacio(doc, altoFila);
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

  private dibujarPie(doc: PDFKit.PDFDocument, timezone: string): void {
    this.asegurarEspacio(doc, 30);
    const x = doc.page.margins.left;
    const y = this.limiteInferior(doc) - 12;
    doc.font('Helvetica').fontSize(7.5).fillColor(PALETA.gris)
      .text(
        `Documento generado automáticamente el ${formatearFechaHora(new Date(), timezone)}`,
        x,
        y,
        { width: this.anchoUtil(doc), lineBreak: false },
      );
  }
}

// ------------------------------------------------------------------ utilitarios

function etiquetaAnomalia(anomalia: ScanAnomaly): string {
  return anomalia.replaceAll('_', ' ');
}

function recortar(texto: string, largo: number): string {
  return texto.length > largo ? `${texto.slice(0, largo - 1)}…` : texto;
}

/** "aaaammdd" para nombres de archivo, siempre en UTC para que sea estable. */
function claveFecha(fecha: Date): string {
  return fecha.toISOString().slice(0, 10).replaceAll('-', '');
}

/** Las horas del informe van en la zona horaria DEL RECINTO, no del servidor. */
function formatearFechaHora(valor: Date | string | null, timezone: string): string {
  if (valor === null) return '—';
  const fecha = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(fecha.getTime())) return '—';
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

function formatearFecha(fecha: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('es-CL', {
      timeZone: timezone,
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(fecha);
  } catch {
    return fecha.toISOString().slice(0, 10);
  }
}

function formatearDiaMes(fecha: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('es-CL', {
      timeZone: timezone,
      day: '2-digit',
      month: '2-digit',
    }).format(fecha);
  } catch {
    return fecha.toISOString().slice(5, 10);
  }
}
