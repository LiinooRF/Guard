import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { checkContrast, type Role } from '@voxia/shared';

import { BrandingService } from '../branding/branding.service';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RulesService } from '../rules/rules.service';
import { MAX_DIAS_ESCANEOS, resolverRango } from '../stats/stats-range';
import { FILTRO_RECINTOS } from '../stats/stats-site-scope';
import { SupervisorService } from '../supervisor/supervisor.service';
import type { ExcelExportQueryDto } from './excel-export.dto';
import {
  construirLibroExcel,
  horaLocalIso,
  HOJA_ESCANEOS,
  HOJA_NOVEDADES,
  HOJA_RONDAS,
  type EscaneoExcelRow,
  type NovedadExcelRow,
  type RondaExcelRow,
} from './excel-export.model';
import { escribirLibroExcel, type HojaExcel } from './excel-xlsx-writer';

/**
 * Exportacion a Excel de rondas, escaneos y novedades (#136).
 *
 * Convive con el PDF, no lo reemplaza: el PDF se le manda al cliente final y el
 * Excel es la materia prima con la que el administrador hace sus cruces. Por
 * eso lleva identificadores y no lleva fotos.
 *
 * Tres cosas que definen el diseño:
 *
 * - **Zona horaria del recinto.** Todas las horas se resuelven en PostgreSQL
 *   con `AT TIME ZONE sites.timezone` y viajan como texto sin zona. El numero
 *   de serie de Excel no tiene zona: si la conversion se hiciera en Node, la
 *   planilla saldria en la zona del servidor.
 * - **El corte del periodo suma el dia ANTES de convertir**
 *   (`($2::date::timestamp + INTERVAL '1 day') AT TIME ZONE s.timezone`). Al
 *   reves, el dia que cambia el horario de verano dura 23 o 25 horas y el
 *   ultimo dia del rango queda corrido.
 * - **Sin coordenadas.** La planilla circula por correo; la ubicacion de un
 *   trabajador no. Las desviaciones se informan como marcas de anomalia, que es
 *   lo que el jefe de operaciones necesita, sin exponer donde estuvo la persona.
 */

/** Quien pide la exportacion. El rol define permisos; el SUPERVISOR trae alcance. */
export interface AlcanceExportacion {
  readonly userId: string;
  readonly role: Role;
}

export interface LibroExportacion {
  readonly hojas: readonly HojaExcel[];
  readonly filename: string;
  readonly colorEncabezado: string;
  readonly colorTextoEncabezado: string;
  readonly generadoEn: Date;
  /** Conteos por hoja. Sirven al log y a los tests; no llevan datos de personas. */
  readonly conteos: { rondas: number; escaneos: number; novedades: number };
}

/**
 * El filtro de recintos visibles NO se declara aca: se importa de
 * `../stats/stats-site-scope`. Es un control de acceso —el SUPERVISOR solo ve
 * sus recintos asignados— y tenerlo escrito dos veces es exactamente como se
 * termina con dos versiones y una desactualizada. Ver ese archivo para el
 * contrato de `$3`, `$4` y `$5`.
 */

/** Formato ISO sin zona: lo que espera serialExcel(). */
const FORMATO_LOCAL = `'YYYY-MM-DD"T"HH24:MI:SS'`;

const TIPO_XLSX =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

@Injectable()
export class ExcelExportService {
  private readonly logger = new Logger(ExcelExportService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly rules: RulesService,
    private readonly branding: BrandingService,
    private readonly supervisor: SupervisorService,
  ) {}

  static readonly contentType = TIPO_XLSX;

  /**
   * Resuelve datos y permisos y arma las hojas. Todo lo que puede fallar
   * (403/404/400) falla ACA, antes de escribir un byte: una vez abierta la
   * descarga ya no se puede responder un JSON de error.
   */
  async construir(
    query: ExcelExportQueryDto,
    quien: AlcanceExportacion,
  ): Promise<LibroExportacion> {
    // El tope de dias es el de la grafica que tambien baja a `scans`: es la
    // tabla mas grande del producto y este es el limite que protege la base.
    const rango = resolverRango(query.from, query.to, MAX_DIAS_ESCANEOS);

    const recinto = query.siteId ? await this.resolverRecinto(query.siteId, quien) : null;

    const reglas = await this.rules.effective({ siteId: query.siteId ?? null });
    const tope = reglas.excelExportMaxRows;

    const parametros = [
      rango.desde,
      rango.hasta,
      quien.role === 'SUPERVISOR' ? quien.userId : null,
      query.siteId ?? null,
      query.branchName ?? null,
      query.guardId ?? null,
      // Una fila mas que el tope: si vuelve, la hoja quedo cortada y hay que
      // decirlo. Un archivo incompleto que no se anuncia es peor que un error.
      tope + 1,
    ];

    const rondas = await this.tenantContext.manager.query<RondaExcelRow[]>(
      this.sqlRondas(),
      parametros,
    );
    const escaneos = await this.tenantContext.manager.query<EscaneoExcelRow[]>(
      this.sqlEscaneos(),
      parametros,
    );
    const novedades = await this.tenantContext.manager.query<NovedadExcelRow[]>(
      this.sqlNovedades(),
      parametros,
    );

    const truncadas: string[] = [];
    const rondasFinal = this.recortar(rondas, tope, HOJA_RONDAS, truncadas);
    const escaneosFinal = this.recortar(escaneos, tope, HOJA_ESCANEOS, truncadas);
    const novedadesFinal = this.recortar(novedades, tope, HOJA_NOVEDADES, truncadas);

    const marca = await this.branding.forDocuments();
    const generadoEn = new Date();
    // Sin filtro de recinto la exportacion puede cruzar zonas horarias (en
    // Chile, America/Santiago y Pacific/Easter conviven en el mismo tenant).
    // Las FILAS estan bien: cada una lleva su columna «Zona horaria». La
    // portada es la que no puede quedar con la zona de la primera fila que
    // devolvio la base, porque es justo lo que se cita tres meses despues.
    const zonas = recinto
      ? [recinto.timezone]
      : zonasDistintas(rondasFinal, escaneosFinal, novedadesFinal);
    const zonaGeneracion = zonas.length === 1 ? zonas[0]! : ZONA_NEUTRA;
    const zonaReferencia = etiquetaZona(zonas);

    const hojas = construirLibroExcel({
      empresa: marca.displayName,
      desde: rango.desde,
      hasta: rango.hasta,
      filtros: {
        recinto: recinto?.name ?? null,
        sucursal: query.branchName ?? null,
        guardia: query.guardId
          ? (rondasFinal[0]?.guard_name ??
            escaneosFinal[0]?.guard_name ??
            novedadesFinal[0]?.guard_name ??
            query.guardId)
          : null,
      },
      generadoEnLocal: horaLocalIso(generadoEn, zonaGeneracion) ?? '',
      zonaReferencia,
      rondas: rondasFinal,
      escaneos: escaneosFinal,
      novedades: novedadesFinal,
      tope,
      truncadas,
    });

    if (truncadas.length > 0) {
      // Sin nombres, sin ubicaciones: tenant y recinto ya los pone el logger
      // estructurado. Solo el hecho de que la exportacion salio incompleta.
      this.logger.warn(
        JSON.stringify({
          event: 'exportacion_excel_truncada',
          hojas: truncadas,
          tope,
          dias: rango.dias,
        }),
      );
    }

    return {
      hojas,
      filename: `exportacion-rondas-${sinGuiones(rango.desde)}-${sinGuiones(rango.hasta)}.xlsx`,
      colorEncabezado: marca.primaryColor,
      colorTextoEncabezado: contrasteDeTexto(marca.primaryColor),
      generadoEn,
      conteos: {
        rondas: rondasFinal.length,
        escaneos: escaneosFinal.length,
        novedades: novedadesFinal.length,
      },
    };
  }

  /** Escribe el libro ya resuelto sobre el destino que decida el llamador. */
  async escribir(libro: LibroExportacion, destino: NodeJS.WritableStream): Promise<void> {
    await escribirLibroExcel(destino, libro.hojas, {
      generadoEn: libro.generadoEn,
      colorEncabezado: libro.colorEncabezado,
      colorTextoEncabezado: libro.colorTextoEncabezado,
    });
  }

  // ------------------------------------------------------------- permisos

  /**
   * Recinto pedido explicitamente.
   *
   * Al SUPERVISOR que pide un recinto que no tiene asignado se le responde 403
   * y no una planilla vacia: una planilla vacia se lee como "aqui no pasa
   * nada". La verificacion se reusa de SupervisorService — duplicar un control
   * de acceso es como se terminan teniendo dos, y uno desactualizado.
   */
  private async resolverRecinto(
    siteId: string,
    quien: AlcanceExportacion,
  ): Promise<{ name: string; timezone: string }> {
    if (quien.role === 'SUPERVISOR') {
      await this.supervisor.ensureAssignedSite(siteId, quien.userId);
    }
    const filas = await this.tenantContext.manager.query<
      Array<{ name: string; timezone: string }>
    >(`SELECT name, timezone FROM sites WHERE id = $1`, [siteId]);
    const recinto = filas[0];
    if (!recinto) throw new NotFoundException('El recinto no existe');
    return recinto;
  }

  private recortar<T>(
    filas: readonly T[],
    tope: number,
    nombreHoja: string,
    truncadas: string[],
  ): T[] {
    if (filas.length <= tope) return [...filas];
    truncadas.push(nombreHoja);
    return filas.slice(0, tope);
  }

  // --------------------------------------------------------------- consultas

  /**
   * Rondas del periodo. El corte es por `scheduled_start_at`, igual que en las
   * graficas: una ronda nocturna pertenece al dia en que estaba PROGRAMADA,
   * aunque cierre pasada la medianoche.
   *
   * Se incluyen las voluntarias (marcadas en su columna) porque esto es materia
   * prima para cruces, no una estadistica: esconderlas obligaria al admin a
   * pedir otra exportacion.
   */
  private sqlRondas(): string {
    return `
        SELECT
          p.id,
          to_char(p.scheduled_start_at AT TIME ZONE s.timezone, 'YYYY-MM-DD') AS fecha_local,
          to_char(p.scheduled_start_at AT TIME ZONE s.timezone, ${FORMATO_LOCAL})
            AS inicio_programado_local,
          to_char(p.scheduled_end_at AT TIME ZONE s.timezone, ${FORMATO_LOCAL})
            AS fin_programado_local,
          to_char(p.started_at AT TIME ZONE s.timezone, ${FORMATO_LOCAL}) AS inicio_real_local,
          to_char(p.closed_at AT TIME ZONE s.timezone, ${FORMATO_LOCAL}) AS cierre_local,
          s.name AS site_name,
          s.branch_name,
          s.timezone,
          r.name AS route_name,
          (u.given_name || ' ' || u.family_name) AS guard_name,
          p.status,
          p.compliance_pct,
          p.is_voluntary,
          jsonb_array_length(p.expected_checkpoint_ids) AS puntos_esperados,
          (SELECT count(DISTINCT sc.checkpoint_id)
             FROM scans sc
            WHERE sc.tenant_id = p.tenant_id AND sc.patrol_id = p.id) AS puntos_marcados,
          (SELECT count(*)
             FROM field_events fe
            WHERE fe.tenant_id = p.tenant_id AND fe.patrol_id = p.id) AS novedades
        FROM patrols p
        JOIN sites s ON s.tenant_id = p.tenant_id AND s.id = p.site_id
        JOIN routes r ON r.tenant_id = p.tenant_id AND r.id = p.route_id
        JOIN users u ON u.id = p.guard_id
        WHERE p.scheduled_start_at >= ($1::date::timestamp AT TIME ZONE s.timezone)
          AND p.scheduled_start_at <  (($2::date::timestamp + INTERVAL '1 day') AT TIME ZONE s.timezone)
          AND ($6::uuid IS NULL OR p.guard_id = $6::uuid)${FILTRO_RECINTOS}
        ORDER BY p.scheduled_start_at, s.name, p.id
        LIMIT $7::int`;
  }

  /**
   * Escaneos de esas mismas rondas.
   *
   * El periodo se corta por la ronda y no por la hora del escaneo, para que las
   * tres hojas hablen del MISMO conjunto: un escaneo que llego dos dias tarde
   * sigue perteneciendo a su ronda, y si se filtrara por su propia hora
   * aparecerian escaneos sin ronda en la planilla.
   *
   * Las fotos se cuentan por `scan_id`, que es la relacion exacta; contar por
   * punto sumaria las de otro escaneo del mismo punto en la misma ronda.
   */
  private sqlEscaneos(): string {
    return `
        SELECT
          sc.id,
          sc.patrol_id,
          to_char(sc.scanned_at_server AT TIME ZONE s.timezone, ${FORMATO_LOCAL})
            AS registrado_local,
          to_char(sc.scanned_at_device AT TIME ZONE s.timezone, ${FORMATO_LOCAL})
            AS dispositivo_local,
          s.name AS site_name,
          s.branch_name,
          s.timezone,
          c.name AS checkpoint_name,
          c.kind,
          sc.method,
          (u.given_name || ' ' || u.family_name) AS guard_name,
          (SELECT count(*)
             FROM scan_photos ph
            WHERE ph.tenant_id = sc.tenant_id AND ph.scan_id = sc.id) AS fotos,
          sc.anomalies,
          sc.clock_offset_ms
        FROM scans sc
        JOIN patrols p ON p.tenant_id = sc.tenant_id AND p.id = sc.patrol_id
        JOIN sites s ON s.tenant_id = p.tenant_id AND s.id = p.site_id
        JOIN checkpoints c ON c.tenant_id = sc.tenant_id AND c.id = sc.checkpoint_id
        JOIN users u ON u.id = p.guard_id
        WHERE p.scheduled_start_at >= ($1::date::timestamp AT TIME ZONE s.timezone)
          AND p.scheduled_start_at <  (($2::date::timestamp + INTERVAL '1 day') AT TIME ZONE s.timezone)
          AND ($6::uuid IS NULL OR p.guard_id = $6::uuid)${FILTRO_RECINTOS}
        ORDER BY sc.scanned_at_server, sc.id
        LIMIT $7::int`;
  }

  /**
   * Novedades del libro de terreno.
   *
   * Aca el corte SI es por la hora del evento: una novedad puede no tener ronda
   * (el guardia reporta un vidrio roto al llegar, antes de iniciar), asi que no
   * hay ventana de ronda de la cual colgarla.
   *
   * `corrects_event_id` se exporta porque el libro es append-only: una
   * correccion es una entrada nueva y la original sigue visible. Sin esa
   * columna, la planilla mostraria dos versiones del mismo hecho sin decir cual
   * corrige a cual.
   */
  private sqlNovedades(): string {
    return `
        SELECT
          fe.id,
          to_char(fe.reported_at_server AT TIME ZONE s.timezone, ${FORMATO_LOCAL})
            AS registrado_local,
          to_char(fe.reported_at_device AT TIME ZONE s.timezone, ${FORMATO_LOCAL})
            AS dispositivo_local,
          s.name AS site_name,
          s.branch_name,
          s.timezone,
          fe.criticality,
          fe.text,
          (u.given_name || ' ' || u.family_name) AS guard_name,
          fe.patrol_id,
          fe.corrects_event_id,
          (SELECT count(*)
             FROM event_photos ep
            WHERE ep.tenant_id = fe.tenant_id AND ep.event_id = fe.id) AS fotos
        FROM field_events fe
        JOIN sites s ON s.tenant_id = fe.tenant_id AND s.id = fe.site_id
        JOIN users u ON u.id = fe.guard_id
        WHERE fe.reported_at_server >= ($1::date::timestamp AT TIME ZONE s.timezone)
          AND fe.reported_at_server <  (($2::date::timestamp + INTERVAL '1 day') AT TIME ZONE s.timezone)
          AND ($6::uuid IS NULL OR fe.guard_id = $6::uuid)${FILTRO_RECINTOS}
        ORDER BY fe.reported_at_server, fe.id
        LIMIT $7::int`;
  }
}

function sinGuiones(dia: string): string {
  return dia.replaceAll('-', '');
}

/** Zona explicita y rotulable cuando la exportacion cruza varios husos. */
const ZONA_NEUTRA = 'UTC';

/**
 * Zonas horarias distintas presentes en lo que se exporto, en el orden en que
 * aparecen. Se mira lo que quedo DESPUES del recorte: la portada describe la
 * planilla que se entrega, no la consulta que se pidio.
 */
function zonasDistintas(
  ...hojas: ReadonlyArray<{ readonly timezone: string }>[]
): string[] {
  const vistas = new Set<string>();
  for (const filas of hojas) {
    for (const fila of filas) {
      if (fila.timezone) vistas.add(fila.timezone);
    }
  }
  return [...vistas];
}

/**
 * Que se escribe en «Zona horaria de referencia».
 *
 * Con una sola zona, su nombre. Con varias NO se elige una al azar: se dice que
 * son varias, cuales son, y en que zona quedo «Generado el». Un dato correcto
 * pero mal rotulado es peor que un dato ausente.
 */
function etiquetaZona(zonas: readonly string[]): string {
  if (zonas.length === 1) return zonas[0]!;
  if (zonas.length === 0) return ZONA_NEUTRA;
  return (
    `varias (${zonas.join(', ')}): ver la columna «Zona horaria» de cada hoja. ` +
    `«Generado el» va en ${ZONA_NEUTRA}.`
  );
}

/**
 * Blanco o negro sobre el color de marca, con la misma regla que la franja del
 * PDF: un amarillo de marca con texto blanco encima es ilegible.
 *
 * Se resuelve aca y no en el escritor de xlsx para que ese archivo siga siendo
 * un escritor de formato y no dependa del paquete compartido.
 */
function contrasteDeTexto(colorMarca: string): string {
  return checkContrast(colorMarca).fillText;
}
