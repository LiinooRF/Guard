import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PatrolRules } from '@sentrycore/shared';

import { comoEntero, filasAfectadas, filasDe } from '../consent/sql-result';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RulesService } from '../rules/rules.service';
import { CRASH_REPORTER, type CrashEvent, type CrashReporter } from './crash-event';
import { CRASH_REPORTING_CONFIG, type CrashReportingConfig } from './crash-reporting.config';
import { huellaDeCaida } from './crash-fingerprint';
import {
  ANDROID_NO_IDENTIFICADO,
  DEVICE_MODELS_PERMITIDOS,
  ERROR_NO_IDENTIFICADO,
  ERROR_NAMES_PERMITIDOS,
  MODELO_NO_IDENTIFICADO,
  PATRON_VERSION_ANDROID,
  PATRON_VERSION_APP,
  VERSION_APP_NO_IDENTIFICADA,
  proyectarGruposResumen,
  type CrashReportSummaryRawGroup,
} from './crash-report-summary.projection';
import { depurarEtiqueta, depurarPila, depurarRuta, depurarTexto } from './crash-scrubber';
import { requestLogContext } from './request-context';
import type { CrashReportSummaryDto } from './dto/crash-report-summary.dto';
import type { ReportCrashDto } from './dto/report-crash.dto';

/**
 * Reporte de caidas: de la app del guardia y del propio servidor (#27).
 *
 * DOS CAMINOS DISTINTOS, Y NO POR CAPRICHO:
 *
 * - La caida de la APP entra por HTTP, se guarda en `app_crash_reports` (con
 *   RLS, o sea que el ADMIN ve lo suyo y nada mas) y ademas se manda al
 *   proveedor. Hay request, hay sesion y hay transaccion.
 * - El error del SERVIDOR solo se manda al proveedor. NO se escribe en la base:
 *   cuando revienta un endpoint, la transaccion del contexto tenant se esta
 *   deshaciendo, y un INSERT ahi adentro se va con el rollback. Escribirlo
 *   igual seria un registro que existe en los tests y no en produccion.
 */

/**
 * Retencion por defecto de los reportes de caida.
 *
 * TODAVIA NO ESTA EN rules.ts, y esto no es un olvido: rules.ts se toca solo en
 * el PR de integracion (ver INTEGRACION.md, seccion "parametros de rules.ts",
 * que trae el zod exacto y la ficha de catalogo). Mientras el parametro no
 * exista, `resolveRules` ni siquiera lo devuelve —su zod descarta las claves
 * que no declara— y se usa este numero, que es EXACTAMENTE el mismo default que
 * declara la ficha. Asi, aplicar la regla no cambia el comportamiento de nadie.
 *
 * 30 dias y no 365 como las fotos: un stacktrace de hace un año no se arregla,
 * ya no existe esa version de la app. Y es dato tecnico de un telefono de una
 * persona: cuanto menos se guarde, mejor.
 */
export const RETENCION_CAIDAS_DIAS_DEFECTO = 30;

/**
 * Tope del texto de pila que se GUARDA, y es el CHECK de la columna:
 * `length(stack) <= 20000` en 1725559200000-CreateAppCrashReports.ts.
 *
 * No alcanza con acotar cada linea: `depurarPila` conserva hasta 40 lineas de
 * hasta 500 caracteres, y unidas con salto de linea eso da 40*500 + 39 = 20.039
 * — treinta y nueve caracteres por encima del CHECK. Un bundle de React Native
 * minificado tiene exactamente esa forma. Se acota el texto YA UNIDO, que es lo
 * unico que Postgres mide.
 *
 * Solo afecta lo que va a la base. Al proveedor se le manda el arreglo de
 * cuadros, que no pasa por esta columna ni por este limite.
 */
const LARGO_MAX_PILA_GUARDADA = 20_000;

/**
 * Tope de grupos que devuelve el resumen. Es un limite de PRESENTACION: nadie
 * mira mas de 50 problemas distintos en una pantalla, y no cambia ninguna
 * decision de la empresa. Por eso no va a rules.ts.
 */
const MAX_GRUPOS_RESUMEN = 50;

/** Lee la retencion efectiva. Ver el comentario de RETENCION_CAIDAS_DIAS_DEFECTO. */
export function retencionDeCaidas(reglas: PatrolRules): number {
  const valor: unknown = (reglas as unknown as Record<string, unknown>).crashReportRetentionDays;
  return typeof valor === 'number' && Number.isInteger(valor) && valor >= 1 && valor <= 365
    ? valor
    : RETENCION_CAIDAS_DIAS_DEFECTO;
}

/** Contexto de un error del servidor. Nada de esto identifica a una persona. */
export interface ContextoErrorServidor {
  method: string;
  path: string;
  statusCode: number;
  tenantId: string | null;
}

export interface ResultadoRegistro {
  registrado: boolean;
  /** 'limite_por_hora' cuando el telefono esta en bucle. */
  motivo?: string;
  enviado: boolean;
}

interface FilaResumen {
  app_version: string;
  device_model: string;
  android_version: string;
  error_name: string;
  total: string | number;
  fatales: string | number;
}

@Injectable()
export class CrashReportingService {
  private readonly logger = new Logger(CrashReportingService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly rules: RulesService,
    @Inject(CRASH_REPORTER) private readonly reporter: CrashReporter,
    @Inject(CRASH_REPORTING_CONFIG) private readonly config: CrashReportingConfig,
  ) {}

  /**
   * Si hay a donde mandar. Lo consulta el interceptor para no pagar ni un pipe
   * de mas por request cuando el driver esta en 'off', que es el default.
   */
  esReportable(): boolean {
    return this.reporter.enabled;
  }

  // ------------------------------------------------------------- app movil

  /**
   * Registra una caida de la app.
   *
   * El controlador ya verifico que la empresa tenga el modulo `crashReporting`
   * (`@RequiresFeature`), asi que aca no se vuelve a preguntar: si llegamos, la
   * empresa lo tiene prendido.
   */
  async registrarCaidaDeApp(
    userId: string,
    tenantId: string | null,
    input: ReportCrashDto,
  ): Promise<ResultadoRegistro> {
    if (!tenantId) {
      // El interceptor de contexto ya devuelve 401 en este caso; esto es la
      // reja de adentro, para que nunca se intente insertar sin empresa.
      throw new BadRequestException('El reporte de fallas es de la app de una empresa');
    }

    // El limite se comprueba PRIMERO: un telefono en bucle de reinicio pega
    // decenas de veces por minuto, y no tiene sentido pagar la purga y la
    // lectura de reglas en cada uno de esos golpes.
    if (await this.superaElLimite(userId)) {
      // Sin excepcion: la app reporta y se olvida. Un 429 la haria reintentar
      // justo cuando el problema es que reintenta demasiado.
      this.logger.warn(
        JSON.stringify({ event: 'crash_report_limitado', limite: this.config.maxPerUserHour }),
      );
      return { registrado: false, motivo: 'limite_por_hora', enviado: false };
    }

    await this.purgarVencidos(retencionDeCaidas(await this.rules.effective()));

    const errorName = depurarEtiqueta(input.errorName, 120) || 'Error';
    const errorMessage = depurarTexto(input.errorMessage) || 'sin mensaje';

    // Las tres etiquetas se depuran UNA vez y se reusan en el INSERT y en el
    // evento: calcularlas dos veces abre la puerta a que la base y el proveedor
    // digan cosas distintas de la misma caida.
    //
    // El respaldo de modelo y version de Android no es cosmetico. Los CHECK son
    // `length(trim(device_model)) BETWEEN 1 AND 64` y
    // `length(trim(android_version)) BETWEEN 1 AND 32`, y `depurarEtiqueta`
    // recorta y ademas cambia comillas y barras por espacio: `""""` sale como
    // cadena vacia y Postgres rechaza la fila. Mismo respaldo que errorName.
    // `appVersion` no lo necesita: su @Matches del DTO no acepta blancos ni
    // ninguno de los caracteres que depurarEtiqueta borra.
    const appVersion = depurarEtiqueta(input.appVersion, 32);
    const deviceModel = depurarEtiqueta(input.deviceModel, 64) || 'desconocido';
    const androidVersion = depurarEtiqueta(input.androidVersion, 32) || 'desconocida';

    const stack = depurarPila(input.stack);
    // Ver LARGO_MAX_PILA_GUARDADA: el tope es del texto unido, no de cada linea.
    const stackGuardado =
      stack.length > 0 ? stack.join('\n').slice(0, LARGO_MAX_PILA_GUARDADA) : null;
    const fingerprint = huellaDeCaida(errorName, errorMessage, stack);
    const fatal = input.fatal ?? true;

    const insertadas = filasDe<{ id: string }>(
      await this.tenantContext.manager.query(
        `INSERT INTO app_crash_reports (
           tenant_id, user_id, source, fatal, app_version, device_model, android_version,
           bridge_protocol_version, error_name, error_message, stack, fingerprint, occurred_at
         )
         VALUES (app_tenant_id(), $1, 'app', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)
         RETURNING id`,
        [
          userId,
          fatal,
          appVersion,
          deviceModel,
          androidVersion,
          input.bridgeProtocolVersion ?? null,
          errorName,
          errorMessage,
          stackGuardado,
          fingerprint,
          input.occurredAt ?? null,
        ],
      ),
    );

    const id = insertadas[0]?.id;
    if (!id) {
      // INSERT ... RETURNING devuelve filas planas; si no vino ninguna, algo
      // muy raro paso y es mejor decirlo que devolver un exito falso.
      this.logger.error(JSON.stringify({ event: 'crash_report_no_guardado' }));
      return { registrado: false, motivo: 'no_guardado', enviado: false };
    }

    const enviado = await this.enviar({
      eventId: id.replace(/-/g, ''),
      level: fatal ? 'fatal' : 'error',
      // La hora del SERVIDOR, no la del telefono: el reloj del telefono miente
      // (#73) y el proveedor descarta los eventos con fecha futura. La hora del
      // telefono queda igual guardada en `occurred_at`, que es donde sirve.
      occurredAt: new Date(),
      release: this.releaseDeLaApp(input.appVersion),
      environment: this.config.environment,
      errorName,
      errorMessage,
      stack,
      fingerprint,
      tags: {
        source: 'app',
        tenant_id: tenantId,
        app_version: appVersion,
        device_model: deviceModel,
        android_version: androidVersion,
        ...(input.bridgeProtocolVersion === undefined
          ? {}
          : { bridge_protocol: String(input.bridgeProtocolVersion) }),
        fatal: fatal ? 'true' : 'false',
      },
      requestId: requestLogContext.current().requestId,
    });

    if (enviado) await this.marcarEnviado(id);

    return { registrado: true, enviado };
  }

  /**
   * Resumen agrupado para el panel del ADMIN.
   *
   * La consulta usa la huella para separar causas, pero NO la selecciona ni la
   * devuelve. Tampoco selecciona mensaje, pila, fechas o ids hacia el servicio:
   * `received_at` queda dentro de PostgreSQL para filtrar y ordenar. La primera
   * proyeccion segura se fusiona ANTES del limite; el servicio la repite como
   * defensa en profundidad y construye el DTO publico de lista cerrada.
   */
  async resumen(dias?: number): Promise<CrashReportSummaryDto> {
    const reglas = await this.rules.effective();
    const retencionDias = retencionDeCaidas(reglas);
    // Nunca mas alla de la retencion: pedir 90 dias cuando se guardan 30 daria
    // un total mas bajo sin explicar por que.
    const ventana = Math.min(dias ?? retencionDias, retencionDias);

    const filas = filasDe<FilaResumen>(
      await this.tenantContext.manager.query(
        `SELECT app_version,
                device_model,
                android_version,
                error_name,
                total,
                fatales
           FROM (
             SELECT error_name,
                    app_version,
                    device_model,
                    android_version,
                    sum(total) AS total,
                    sum(fatales) AS fatales,
                    max(ultima) AS ultima
               FROM (
                 SELECT CASE
                          WHEN trim(error_name) = ANY($2::text[]) THEN trim(error_name)
                          ELSE $3::text
                        END AS error_name,
                        CASE
                          WHEN app_version ~ $4 THEN app_version
                          ELSE $5::text
                        END AS app_version,
                        CASE
                          WHEN trim(device_model) = ANY($6::text[]) THEN trim(device_model)
                          ELSE $7::text
                        END AS device_model,
                        CASE
                          WHEN trim(android_version) ~ $8 THEN trim(android_version)
                          ELSE $9::text
                        END AS android_version,
                        total,
                        fatales,
                        ultima
                   FROM (
                     SELECT app_version,
                            device_model,
                            android_version,
                            min(error_name) AS error_name,
                            count(*) AS total,
                            count(*) FILTER (WHERE fatal) AS fatales,
                            max(received_at) AS ultima
                       FROM app_crash_reports
                      WHERE tenant_id = app_tenant_id()
                        AND received_at > now() - make_interval(days => $1::int)
                      GROUP BY app_version, device_model, android_version, fingerprint
                   ) AS crudos
              ) AS seguros
              GROUP BY error_name, app_version, device_model, android_version
           ) AS fusionados
          ORDER BY total DESC, ultima DESC
          LIMIT $10`,
        [
          ventana,
          [...ERROR_NAMES_PERMITIDOS],
          ERROR_NO_IDENTIFICADO,
          PATRON_VERSION_APP.source,
          VERSION_APP_NO_IDENTIFICADA,
          [...DEVICE_MODELS_PERMITIDOS],
          MODELO_NO_IDENTIFICADO,
          PATRON_VERSION_ANDROID.source,
          ANDROID_NO_IDENTIFICADO,
          MAX_GRUPOS_RESUMEN,
        ],
      ),
    );

    const crudos: CrashReportSummaryRawGroup[] = filas.map((fila) => ({
      errorName: fila.error_name,
      appVersion: fila.app_version,
      deviceModel: fila.device_model,
      androidVersion: fila.android_version,
      total: fila.total,
      fatales: fila.fatales,
    }));

    return {
      ventanaDias: ventana,
      retencionDias,
      grupos: proyectarGruposResumen(crudos, MAX_GRUPOS_RESUMEN),
    };
  }

  // --------------------------------------------------------- lado servidor

  /**
   * Un error del servidor hacia el proveedor. NUNCA lanza: la llama el
   * interceptor desde el camino de error, y un error dentro del manejo de otro
   * error deja al cliente sin respuesta.
   *
   * No pasa por el feature flag del tenant: ese flag decide si la APP DE LA
   * EMPRESA manda sus caidas. Un 500 en nuestro servidor es una falla de la
   * plataforma, y el evento no lleva nada de la empresa mas alla de su uuid.
   */
  async reportarErrorDeServidor(
    error: unknown,
    contexto: ContextoErrorServidor,
  ): Promise<boolean> {
    if (!this.reporter.enabled) return false;

    try {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      const errorMessage = depurarTexto(
        error instanceof Error ? error.message : 'error sin mensaje',
      );
      const stack = depurarPila(error instanceof Error ? error.stack : undefined);
      const ruta = depurarRuta(contexto.path);

      return await this.enviar({
        eventId: randomUUID().replace(/-/g, ''),
        level: 'error',
        occurredAt: new Date(),
        release: this.config.release,
        environment: this.config.environment,
        errorName,
        errorMessage,
        stack,
        fingerprint: huellaDeCaida(errorName, errorMessage, [
          `${contexto.method} ${ruta}`,
          ...stack,
        ]),
        tags: {
          source: 'api',
          ...(contexto.tenantId ? { tenant_id: contexto.tenantId } : {}),
          http_route: `${contexto.method} ${ruta}`,
        },
        requestId: requestLogContext.current().requestId,
      });
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------- privados

  /** Envio con la red aislada: cualquier problema del proveedor muere aca. */
  private async enviar(evento: CrashEvent): Promise<boolean> {
    if (!this.reporter.enabled) return false;
    try {
      return await this.reporter.send(evento);
    } catch {
      return false;
    }
  }

  /**
   * Release para el proveedor. Se etiqueta con la version de la APP, no con la
   * de la API: el stacktrace que hay que mapear es el del telefono.
   */
  private releaseDeLaApp(appVersion: string): string {
    const version = depurarEtiqueta(appVersion, 32);
    return version ? `sentrycore-app@${version}` : this.config.release;
  }

  /** Purga por retencion. Se hace al recibir; no hay proceso aparte que barra. */
  private async purgarVencidos(retencionDias: number): Promise<void> {
    // OJO: con Postgres, un DELETE por manager.query() devuelve [filas, rowCount]
    // y NO un arreglo de filas. `filasAfectadas` es lo unico que lee bien las dos
    // formas; `resultado.length` contaria 2 siempre.
    const borradas = filasAfectadas(
      await this.tenantContext.manager.query(
        `DELETE FROM app_crash_reports
          WHERE tenant_id = app_tenant_id()
            AND received_at < now() - make_interval(days => $1::int)`,
        [retencionDias],
      ),
    );

    if (borradas > 0) {
      this.logger.log(
        JSON.stringify({
          event: 'crash_reports_purgados',
          borrados: borradas,
          retencion_dias: retencionDias,
        }),
      );
    }
  }

  /** Cuantas caidas lleva este usuario en la ultima hora. */
  private async superaElLimite(userId: string): Promise<boolean> {
    const filas = filasDe<{ total: string | number }>(
      await this.tenantContext.manager.query(
        `SELECT count(*) AS total
           FROM app_crash_reports
          WHERE tenant_id = app_tenant_id()
            AND user_id = $1
            AND received_at > now() - make_interval(hours => 1)`,
        [userId],
      ),
    );

    // count(*) es bigint y el driver lo entrega como TEXTO: sin comoEntero,
    // '21' > 20 compara cadenas y devuelve lo que no corresponde.
    return comoEntero(filas[0]?.total) >= this.config.maxPerUserHour;
  }

  private async marcarEnviado(id: string): Promise<void> {
    const actualizadas = filasAfectadas(
      await this.tenantContext.manager.query(
        `UPDATE app_crash_reports
            SET forwarded = true
          WHERE tenant_id = app_tenant_id() AND id = $1`,
        [id],
      ),
    );

    if (actualizadas === 0) {
      this.logger.warn(JSON.stringify({ event: 'crash_report_marca_envio_sin_efecto' }));
    }
  }
}
