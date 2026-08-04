import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { canUsePlatform, ROLES, type Role } from '@voxia/shared';

import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RulesService } from '../rules/rules.service';
import type { OffShiftAuditQuery } from './dto/off-shift-audit.dto';
import type { PublishPolicyDto } from './dto/publish-policy.dto';
import { comoEntero, filasAfectadas, filasDe } from './sql-result';

/**
 * Quien puede ser rastreado: los roles que operan desde la APP. Se deriva de
 * ROLE_PLATFORMS en vez de escribir la lista a mano — si manana un rol nuevo
 * entra a la app, aparece solo en el registro de consentimiento en vez de quedar
 * silenciosamente afuera.
 */
const ROLES_EN_TERRENO: readonly Role[] = ROLES.filter((rol) => canUsePlatform(rol, 'app'));

/** Estado del consentimiento de una persona frente al aviso vigente. */
export type EstadoConsentimiento =
  | 'vigente'
  | 'desactualizado'
  | 'revocado'
  | 'nunca_aceptado';

export interface ActorConsentimiento {
  readonly sub: string;
}

interface FilaPolitica {
  id: string;
  version: string;
  body: string;
  privacy_policy_url: string;
  published_at: Date;
  retired_at: Date | null;
}

interface FilaAceptacion {
  granted_at: Date;
  revoked_at: Date | null;
  policy_version: string;
  device_info: string | null;
}

interface FilaRegistro {
  user_id: string;
  nombre: string;
  role_key: string;
  is_active: boolean;
  granted_at: Date | null;
  revoked_at: Date | null;
  policy_version: string | null;
  device_info: string | null;
}

interface FilaHistorial {
  id: string;
  version: string;
  privacy_policy_url: string;
  published_at: Date;
  retired_at: Date | null;
  publicado_por: string | null;
  aceptaciones: string;
  vigentes: string;
}

interface FilaResumenAuditoria {
  puntos: string;
  rondas: string;
  guardias: string;
  antes_de_inicio: string;
  despues_de_cierre: string;
  sin_consentimiento: string;
}

interface FilaHallazgo {
  site_id: string;
  site_name: string;
  site_timezone: string;
  dia_local: string;
  puntos: string;
  antes_de_inicio: string;
  despues_de_cierre: string;
  sin_consentimiento: string;
}

/**
 * Ventana de posiciones del periodo, ya clasificadas.
 *
 * Tres cosas que solo se ven bien aca:
 *
 *  1. El periodo se acota en la ZONA DEL RECINTO (sites.timezone). El dia
 *     siguiente se calcula sumando 1 al date y recien despues se convierte a
 *     timestamptz: si se sumaran 24 horas al instante ya convertido, los dias
 *     con cambio de horario quedarian corridos una hora.
 *  2. "Fuera de turno" es exactamente lo que rechaza GeoService.appendTrack:
 *     antes del inicio real de la ronda, o despues de su cierre. Se comparan las
 *     mismas columnas, asi el informe no es una segunda definicion de la regla.
 *  3. La tolerancia de reloj (consentOffShiftToleranceMin) evita acusar de
 *     rastreo fuera de turno a un telefono con el reloj corrido dos minutos.
 */
const VENTANA_SQL = `
  WITH ventana AS (
    SELECT
      pt.patrol_id,
      pt.guard_id,
      pt.recorded_at_device,
      s.id AS site_id,
      s.name AS site_name,
      s.timezone AS site_timezone,
      -- El dia al que pertenece la posicion SEGUN EL RELOJ DEL RECINTO. Se
      -- calcula aca una sola vez y el detalle agrupa por esta columna.
      (pt.recorded_at_device AT TIME ZONE s.timezone)::date AS fecha_local,
      (pt.recorded_at_device < COALESCE(p.started_at, p.scheduled_start_at)) AS antes_de_inicio,
      (
        p.closed_at IS NOT NULL
        AND pt.recorded_at_device > p.closed_at + ($3::int * interval '1 minute')
      ) AS despues_de_cierre,
      EXISTS (
        SELECT 1
        FROM gps_consents g
        WHERE g.tenant_id = pt.tenant_id
          AND g.user_id = pt.guard_id
          AND g.granted_at <= pt.recorded_at_device
          AND (g.revoked_at IS NULL OR g.revoked_at > pt.recorded_at_device)
      ) AS con_consentimiento
    FROM patrol_tracks pt
    JOIN patrols p ON p.tenant_id = pt.tenant_id AND p.id = pt.patrol_id
    JOIN sites s ON s.tenant_id = p.tenant_id AND s.id = p.site_id
    WHERE pt.recorded_at_device >= (($1::date)::timestamp AT TIME ZONE s.timezone)
      AND pt.recorded_at_device < ((($2::date + 1)::timestamp) AT TIME ZONE s.timezone)
      AND ($4::uuid IS NULL OR s.id = $4::uuid)
  )
`;

/**
 * Consentimiento del trabajador y cumplimiento legal del rastreo (#78).
 *
 * Este modulo NO reemplaza a GeoService: alli sigue viviendo la aceptacion y la
 * revocacion (gps_consents), que es un acto de cada persona sobre su propia
 * cuenta. Aca vive lo que faltaba para que esa aceptacion valga como prueba:
 *
 *   - el TEXTO que se acepto, publicado por la empresa y congelado;
 *   - el REGISTRO por trabajador, con fecha, para mostrarselo a un fiscalizador;
 *   - el INFORME que demuestra que no hay posiciones fuera del turno.
 *
 * Sin el texto, "aceptó la v2" es una cadena de caracteres que eligio el
 * telefono. Con el texto, es evidencia del aviso previo.
 */
@Injectable()
export class ConsentService {
  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly rules: RulesService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------ el aviso

  /**
   * Lo que la pantalla de consentimiento necesita para armarse: el texto
   * vigente y en que estado esta QUIEN pregunta. Lo pide cualquier usuario
   * autenticado y siempre sobre si mismo — nadie consulta el consentimiento de
   * otro por esta via.
   */
  async currentPolicy(userId: string) {
    const politica = await this.politicaVigente();
    const aceptacion = await this.ultimaAceptacion(userId);
    const reglas = await this.rules.effective();

    const estado = this.estadoDe(aceptacion, politica?.version ?? null);

    return {
      hasPolicy: politica !== null,
      policy: politica
        ? {
            version: politica.version,
            body: politica.body,
            privacyPolicyUrl: politica.privacy_policy_url,
            publishedAt: politica.published_at,
          }
        : null,
      acceptance: {
        status: estado,
        acceptedVersion: aceptacion?.policy_version ?? null,
        grantedAt: aceptacion?.granted_at ?? null,
        revokedAt: aceptacion?.revoked_at ?? null,
        deviceInfo: aceptacion?.device_info ?? null,
      },
      // Los tres numeros que la app tiene que MOSTRAR en el aviso. Salen de las
      // reglas del tenant, no del codigo del telefono.
      tracking: {
        // gpsTrackingEnabled y NO gpsSharingRequired: con GPS "opcional" este
        // aviso decia que no se registra ubicacion mientras el servidor si la
        // registraba para quien habia aceptado. Un aviso legal que miente es
        // peor que no tener aviso.
        enabled: reglas.gpsTrackingEnabled,
        sampleIntervalSeconds: reglas.gpsTrackIntervalSeconds,
        retentionDays: reglas.gpsTrackRetentionDays,
      },
      /** Que tiene que hacer la interfaz, ya resuelto por el servidor. */
      actionRequired: !politica
        ? ('publicar_aviso' as const)
        : estado === 'vigente'
          ? ('ninguna' as const)
          : estado === 'desactualizado'
            ? ('reaceptar' as const)
            : ('aceptar' as const),
    };
  }

  /**
   * El admin publica una version nueva del aviso.
   *
   * Retirar la anterior y abrir la nueva ocurre dentro de la MISMA transaccion
   * del request (la abre TenantContextInterceptor): el indice unico parcial
   * consent_policies_vigente_idx no admite dos vigentes ni por un instante.
   *
   * Si consentReacceptOnNewPolicy esta activo, los consentimientos que quedaron
   * apuntando al texto viejo se cierran. Es lo que hace que el aviso nuevo sirva
   * de algo: sin esto, alguien seguiria siendo rastreado bajo un texto que ya no
   * es el que la empresa aplica y que nunca leyo.
   */
  async publishPolicy(actor: ActorConsentimiento, input: PublishPolicyDto) {
    const version = input.version.trim();
    const cuerpo = input.body.trim();
    const url = input.privacyPolicyUrl.trim();

    const repetidas = filasDe<{ id: string }>(
      await this.tenantContext.manager.query(
        `SELECT id FROM consent_policies WHERE version = $1`,
        [version],
      ),
    );
    if (repetidas.length) {
      throw new ConflictException(
        `Ya publicaste una versión llamada "${version}". Usa un nombre nuevo: un texto publicado no se reescribe.`,
      );
    }

    const vigente = await this.politicaVigente();
    if (vigente) {
      await this.tenantContext.manager.query(
        `UPDATE consent_policies SET retired_at = now() WHERE id = $1`,
        [vigente.id],
      );
    }

    const creadas = filasDe<{ id: string; published_at: Date }>(
      await this.tenantContext.manager.query(
        `INSERT INTO consent_policies (
          tenant_id, version, body, privacy_policy_url, published_by
        ) VALUES (app_tenant_id(), $1, $2, $3, $4)
        RETURNING id, published_at`,
        [version, cuerpo, url, actor.sub],
      ),
    );
    const creada = creadas[0];
    if (!creada) throw new ConflictException('No se pudo publicar el aviso');

    const reglas = await this.rules.effective();
    let reaceptacionesPendientes = 0;
    if (reglas.consentReacceptOnNewPolicy) {
      // UPDATE: el driver devuelve [filas, rowCount]. filasAfectadas() lee el
      // rowCount de verdad en vez de contar un arreglo que no son filas.
      reaceptacionesPendientes = filasAfectadas(
        await this.tenantContext.manager.query(
          `UPDATE gps_consents SET revoked_at = now()
           WHERE revoked_at IS NULL AND policy_version <> $1
           RETURNING id`,
          [version],
        ),
      );
    }

    await this.registrarEnAuditoria(actor.sub, creada.id, version, reaceptacionesPendientes);

    return {
      id: creada.id,
      version,
      publishedAt: creada.published_at,
      privacyPolicyUrl: url,
      replacedVersion: vigente?.version ?? null,
      /** Personas que quedaron sin consentimiento vigente y deben aceptar de nuevo. */
      pendingReacceptance: reaceptacionesPendientes,
      reacceptanceEnforced: reglas.consentReacceptOnNewPolicy,
    };
  }

  /** Historial de versiones, con cuanta gente acepto cada una. Sin el texto. */
  async policyHistory() {
    const filas = filasDe<FilaHistorial>(
      await this.tenantContext.manager.query(
        `SELECT p.id,
                p.version,
                p.privacy_policy_url,
                p.published_at,
                p.retired_at,
                (u.given_name || ' ' || u.family_name) AS publicado_por,
                (SELECT count(*) FROM gps_consents c WHERE c.policy_version = p.version)::text
                  AS aceptaciones,
                (SELECT count(*) FROM gps_consents c
                  WHERE c.policy_version = p.version AND c.revoked_at IS NULL)::text
                  AS vigentes
         FROM consent_policies p
         LEFT JOIN users u ON u.id = p.published_by
         ORDER BY p.published_at DESC
         LIMIT 50`,
      ),
    );

    return filas.map((fila) => ({
      id: fila.id,
      version: fila.version,
      privacyPolicyUrl: fila.privacy_policy_url,
      publishedAt: fila.published_at,
      retiredAt: fila.retired_at,
      // Puede venir null si el admin que publico ya no existe: la fila del aviso
      // sigue valiendo igual, por eso el LEFT JOIN y no un INNER.
      publishedBy: fila.publicado_por,
      acceptances: comoEntero(fila.aceptaciones),
      activeAcceptances: comoEntero(fila.vigentes),
      isCurrent: fila.retired_at === null,
    }));
  }

  /**
   * El texto completo de una version, incluida una ya retirada.
   *
   * Es la pieza que se muestra cuando alguien pregunta "¿que decia exactamente
   * lo que firmo esta persona en marzo?".
   */
  async policyDetail(policyId: string) {
    const filas = filasDe<FilaPolitica & { publicado_por: string | null }>(
      await this.tenantContext.manager.query(
        `SELECT p.id, p.version, p.body, p.privacy_policy_url, p.published_at, p.retired_at,
                (u.given_name || ' ' || u.family_name) AS publicado_por
         FROM consent_policies p
         LEFT JOIN users u ON u.id = p.published_by
         WHERE p.id = $1`,
        [policyId],
      ),
    );
    const politica = filas[0];
    if (!politica) throw new NotFoundException('Ese aviso no existe');

    return {
      id: politica.id,
      version: politica.version,
      body: politica.body,
      privacyPolicyUrl: politica.privacy_policy_url,
      publishedAt: politica.published_at,
      retiredAt: politica.retired_at,
      publishedBy: politica.publicado_por,
      isCurrent: politica.retired_at === null,
    };
  }

  // ------------------------------------------------- registro por persona

  /**
   * "Existe registro de consentimiento por trabajador, con fecha."
   *
   * Lista a TODA la gente que la app puede rastrear, no solo a la que acepto:
   * quien falta es justamente lo que hay que ver. Se ordena con los pendientes
   * arriba porque el admin abre esto para encontrar el hueco.
   */
  async roster() {
    const politica = await this.politicaVigente();
    const filas = filasDe<FilaRegistro>(
      await this.tenantContext.manager.query(
        `SELECT m.user_id,
                (u.given_name || ' ' || u.family_name) AS nombre,
                m.role_key,
                u.is_active,
                c.granted_at,
                c.revoked_at,
                c.policy_version,
                c.device_info
         FROM memberships m
         JOIN users u ON u.id = m.user_id
         LEFT JOIN LATERAL (
           SELECT g.granted_at, g.revoked_at, g.policy_version, g.device_info
           FROM gps_consents g
           WHERE g.tenant_id = m.tenant_id AND g.user_id = m.user_id
           ORDER BY g.granted_at DESC
           LIMIT 1
         ) c ON true
         WHERE m.role_key = ANY($1::text[])
         ORDER BY (c.granted_at IS NULL) DESC, u.family_name, u.given_name`,
        [[...ROLES_EN_TERRENO]],
      ),
    );

    const personas = filas.map((fila) => {
      const aceptacion: FilaAceptacion | null =
        fila.granted_at === null || fila.policy_version === null
          ? null
          : {
              granted_at: fila.granted_at,
              revoked_at: fila.revoked_at,
              policy_version: fila.policy_version,
              device_info: fila.device_info,
            };
      return {
        userId: fila.user_id,
        name: fila.nombre,
        role: fila.role_key,
        isActive: fila.is_active,
        status: this.estadoDe(aceptacion, politica?.version ?? null),
        grantedAt: fila.granted_at,
        revokedAt: fila.revoked_at,
        acceptedVersion: fila.policy_version,
        deviceInfo: fila.device_info,
      };
    });

    const cuenta = (estado: EstadoConsentimiento) =>
      personas.filter((persona) => persona.status === estado).length;

    return {
      currentVersion: politica?.version ?? null,
      publishedAt: politica?.published_at ?? null,
      people: personas,
      summary: {
        total: personas.length,
        current: cuenta('vigente'),
        outdated: cuenta('desactualizado'),
        revoked: cuenta('revocado'),
        never: cuenta('nunca_aceptado'),
      },
    };
  }

  // --------------------------------------- no se rastrea fuera del turno

  /**
   * "Se puede demostrar que no hay registros de ubicacion fuera de turno."
   *
   * No es una promesa del cliente movil ni un parrafo de un documento: se
   * recorren las posiciones REALMENTE guardadas del periodo y se contrasta cada
   * una contra la ventana de su ronda y contra el consentimiento vigente en ese
   * instante.
   *
   * El detalle devuelve SOLO los dias con hallazgos. Un informe limpio es una
   * lista vacia y un resumen en cero: eso es lo que se le muestra a quien
   * fiscaliza.
   */
  async offShiftAudit(query: OffShiftAuditQuery) {
    if (query.from > query.to) {
      throw new BadRequestException('La fecha de inicio es posterior a la de término');
    }

    const reglas = await this.rules.effective();
    const parametros = [
      query.from,
      query.to,
      reglas.consentOffShiftToleranceMin,
      query.siteId ?? null,
    ];

    const resumenFilas = filasDe<FilaResumenAuditoria>(
      await this.tenantContext.manager.query(
        `${VENTANA_SQL}
         SELECT count(*)::text AS puntos,
                count(DISTINCT patrol_id)::text AS rondas,
                count(DISTINCT guard_id)::text AS guardias,
                count(*) FILTER (WHERE antes_de_inicio)::text AS antes_de_inicio,
                count(*) FILTER (WHERE despues_de_cierre)::text AS despues_de_cierre,
                count(*) FILTER (WHERE NOT con_consentimiento)::text AS sin_consentimiento
         FROM ventana`,
        parametros,
      ),
    );
    const resumen = resumenFilas[0];

    const hallazgos = filasDe<FilaHallazgo>(
      await this.tenantContext.manager.query(
        `${VENTANA_SQL}
         SELECT site_id,
                site_name,
                site_timezone,
                -- to_char y no la columna date cruda: el driver convierte un
                -- date a Date de JavaScript y al serializarlo a JSON se corre
                -- de dia segun el huso del servidor. El dia del recinto viaja
                -- como texto y llega tal cual se calculo.
                to_char(fecha_local, 'YYYY-MM-DD') AS dia_local,
                count(*)::text AS puntos,
                count(*) FILTER (WHERE antes_de_inicio)::text AS antes_de_inicio,
                count(*) FILTER (WHERE despues_de_cierre)::text AS despues_de_cierre,
                count(*) FILTER (WHERE NOT con_consentimiento)::text AS sin_consentimiento
         FROM ventana
         GROUP BY site_id, site_name, site_timezone, fecha_local
         HAVING count(*) FILTER (
                  WHERE antes_de_inicio OR despues_de_cierre OR NOT con_consentimiento
                ) > 0
         ORDER BY fecha_local DESC, site_name
         LIMIT 100`,
        parametros,
      ),
    );

    const antesDeInicio = comoEntero(resumen?.antes_de_inicio);
    const despuesDeCierre = comoEntero(resumen?.despues_de_cierre);
    const sinConsentimiento = comoEntero(resumen?.sin_consentimiento);

    return {
      from: query.from,
      to: query.to,
      siteId: query.siteId ?? null,
      toleranceMin: reglas.consentOffShiftToleranceMin,
      summary: {
        points: comoEntero(resumen?.puntos),
        patrols: comoEntero(resumen?.rondas),
        guards: comoEntero(resumen?.guardias),
        beforeStart: antesDeInicio,
        afterClose: despuesDeCierre,
        // antes_de_inicio y despues_de_cierre se excluyen entre si, asi que la
        // suma no cuenta dos veces el mismo punto.
        outsideShift: antesDeInicio + despuesDeCierre,
        withoutConsent: sinConsentimiento,
      },
      /** Limpio = ni una posicion fuera de turno ni una sin consentimiento. */
      compliant: antesDeInicio === 0 && despuesDeCierre === 0 && sinConsentimiento === 0,
      findings: hallazgos.map((fila) => ({
        siteId: fila.site_id,
        siteName: fila.site_name,
        timezone: fila.site_timezone,
        // Fecha del RECINTO, no del servidor ni del navegador.
        localDate: fila.dia_local,
        points: comoEntero(fila.puntos),
        beforeStart: comoEntero(fila.antes_de_inicio),
        afterClose: comoEntero(fila.despues_de_cierre),
        withoutConsent: comoEntero(fila.sin_consentimiento),
      })),
      truncated: hallazgos.length === 100,
    };
  }

  // ----------------------------------------------------------------- apoyo

  private async politicaVigente(): Promise<FilaPolitica | null> {
    const filas = filasDe<FilaPolitica>(
      await this.tenantContext.manager.query(
        `SELECT id, version, body, privacy_policy_url, published_at, retired_at
         FROM consent_policies
         WHERE retired_at IS NULL
         LIMIT 1`,
      ),
    );
    return filas[0] ?? null;
  }

  private async ultimaAceptacion(userId: string): Promise<FilaAceptacion | null> {
    const filas = filasDe<FilaAceptacion>(
      await this.tenantContext.manager.query(
        `SELECT granted_at, revoked_at, policy_version, device_info
         FROM gps_consents
         WHERE user_id = $1
         ORDER BY granted_at DESC
         LIMIT 1`,
        [userId],
      ),
    );
    return filas[0] ?? null;
  }

  /**
   * Sin aviso publicado NADIE esta "vigente": lo que haya en gps_consents
   * apunta a un texto que el producto no puede mostrar, y un consentimiento que
   * no se puede exhibir no acredita nada.
   */
  private estadoDe(
    aceptacion: FilaAceptacion | null,
    versionVigente: string | null,
  ): EstadoConsentimiento {
    if (!aceptacion) return 'nunca_aceptado';
    if (aceptacion.revoked_at !== null) return 'revocado';
    if (versionVigente === null) return 'desactualizado';
    return aceptacion.policy_version === versionVigente ? 'vigente' : 'desactualizado';
  }

  /**
   * Publicar un aviso es una accion sensible: cambia lo que se le informa a las
   * personas y puede dejar a toda la operacion sin consentimiento vigente. El
   * registro NO lleva el texto (hasta 20.000 caracteres) ni nombres: lleva quien,
   * cuando, que version y a cuanta gente afecto.
   */
  private async registrarEnAuditoria(
    actorId: string,
    policyId: string,
    version: string,
    pendientes: number,
  ): Promise<void> {
    const actores = filasDe<{ label: string }>(
      await this.tenantContext.manager.query(
        `SELECT (given_name || ' ' || family_name) AS label FROM users WHERE id = $1`,
        [actorId],
      ),
    );
    await this.audit.record({
      actorId,
      actorLabel: actores[0]?.label ?? 'usuario desconocido',
      action: 'consentimiento.aviso_publicado',
      entityType: 'consent_policy',
      entityId: policyId,
      summary:
        pendientes > 0
          ? `Aviso de geolocalización "${version}" publicado; ${pendientes} persona(s) deben aceptarlo de nuevo`
          : `Aviso de geolocalización "${version}" publicado`,
    });
  }
}
