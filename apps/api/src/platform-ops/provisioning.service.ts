import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { patrolRulesSchema } from '@sentrycore/shared';
import { argon2id, hash } from 'argon2';
import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';

import { createAuthActionToken } from '../auth/auth-action-token';
import { MailService } from '../auth/mail.service';
import type { ProvisionTenantDto } from './dto/provision-tenant.dto';

/** Igual que la invitacion de AdminService: el enlace del correo lo dice. */
const INVITATION_TTL_MS = 24 * 60 * 60 * 1000;

interface ProvisionResult {
  tenant_id: string;
  admin_user_id: string;
  site_id: string | null;
}

/**
 * Alta completa de una empresa cliente. Issue #105.
 *
 * Complementa a PlatformService.createTenant en vez de reemplazarlo: aquel crea
 * el par tenant+admin con una clave que escribe el SUPERADMIN; este deja la
 * empresa OPERABLE —admin invitado por correo, reglas, recinto de ejemplo— y
 * nunca conoce la clave del administrador del cliente.
 *
 * Corre SIN contexto de tenant, como SupportAccessService: usa el DataSource
 * directo. Todo el cruce de datos ocurre dentro de platform_provision_tenant,
 * que exige assert_platform_superadmin; ver la migracion
 * 1724684400000-CreateTenantProvisioning para por que no se setea app.tenant_id
 * a mano.
 */
@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly mail: MailService,
  ) {}

  /**
   * Atomicidad: la transaccion abarca los ocho INSERT (tenant, usuario,
   * membresia, reglas, recinto, token de invitacion, auditoria de plataforma y
   * auditoria del tenant) Y el encolado del correo. Si el correo no se puede
   * encolar, el throw revierte TODO: preferimos que el SUPERADMIN reintente el
   * alta completa antes que dejar una empresa cuyo unico administrador no
   * recibio como entrar. La ventana residual —correo encolado y despues falla
   * el commit— produce un enlace de invitacion muerto, sin empresa detras y sin
   * dato filtrado; eso se resuelve repitiendo el alta.
   */
  async altaCompleta(actorId: string, input: ProvisionTenantDto) {
    const overrides = this.validarReglas(input.ruleOverrides);

    const tenantId = randomUUID();
    const adminUserId = randomUUID();
    const siteId = input.sampleSite ? randomUUID() : null;
    const adminEmail = input.admin.email.toLowerCase();

    // El SUPERADMIN no elige la clave del ADMIN del cliente y la plataforma no
    // la conoce: se siembra una aleatoria que nadie recibe y el administrador
    // define la suya desde la invitacion. Es la diferencia entre "te creamos la
    // cuenta" y "tenemos tu clave".
    const passwordHash = await hash(randomBytes(32).toString('base64url'), {
      type: argon2id,
      memoryCost: 65_536,
      timeCost: 3,
      parallelism: 1,
    });
    const invitation = createAuthActionToken(INVITATION_TTL_MS);

    try {
      const result = await this.dataSource.transaction(async (manager) => {
        await manager.query(`SELECT set_config('app.user_id', $1, true)`, [actorId]);

        const rows = await manager.query<Array<{ resultado: ProvisionResult }>>(
          `SELECT platform_provision_tenant(
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
            $12, $13, $14::jsonb, $15, $16, $17, $18
          ) AS resultado`,
          [
            actorId,
            tenantId,
            input.slug,
            input.legalName,
            input.displayName,
            input.planKey,
            adminUserId,
            adminEmail,
            passwordHash,
            input.admin.givenName,
            input.admin.familyName,
            invitation.tokenHash,
            invitation.expiresAt,
            JSON.stringify(overrides),
            siteId,
            input.sampleSite?.branchName ?? null,
            input.sampleSite?.name ?? null,
            input.sampleSite?.address ?? null,
          ],
        );

        try {
          await this.mail.invitation(
            adminEmail,
            invitation.token,
            tenantId,
            `invitation:${invitation.tokenHash}`,
          );
        } catch (error) {
          this.logger.warn(
            JSON.stringify({
              event: 'provisioning_correo_fallo',
              tenant_id: tenantId,
              message: error instanceof Error ? error.message : String(error),
            }),
          );
          throw new ServiceUnavailableException(
            'No fue posible enviar la invitación: no se creó la empresa. Reinténtalo.',
          );
        }

        return rows[0]?.resultado ?? null;
      });

      return {
        tenantId: result?.tenant_id ?? tenantId,
        adminUserId: result?.admin_user_id ?? adminUserId,
        siteId: result?.site_id ?? null,
        invitationSent: true,
        invitationExpiresAt: invitation.expiresAt,
        ruleOverrides: overrides,
      };
    } catch (error) {
      throw this.traducir(error);
    }
  }

  /**
   * Mismo criterio que RulesService: el DTO de reglas ES el schema compartido.
   * strict() para que una regla mal escrita sea 400 y no un descarte silencioso
   * que deje al tenant nuevo operando con un default que nadie pidió.
   */
  private validarReglas(raw: Record<string, unknown> | undefined) {
    if (!raw) return {};
    const parsed = patrolRulesSchema.partial().strict().safeParse(raw);
    if (!parsed.success) {
      throw new BadRequestException(
        parsed.error.issues.map(
          (issue) => `ruleOverrides.${issue.path.join('.') || '?'}: ${issue.message}`,
        ),
      );
    }
    return parsed.data;
  }

  private traducir(error: unknown): Error {
    if (!(error instanceof QueryFailedError)) {
      return error instanceof Error ? error : new Error(String(error));
    }
    const code = error.driverError?.code;
    if (code === '23505') {
      return new ConflictException('El slug o el correo ya están registrados');
    }
    if (code === '23503' && error.driverError?.constraint === 'tenants_plan_key_fkey') {
      return new BadRequestException('El plan indicado no existe');
    }
    if (code === '42501') {
      // El guard ya exigio el permiso; esto es la reja de la base, que es la
      // que manda. Un 500 aca esconderia un problema de autorizacion real.
      return new ForbiddenException('Solo un SUPERADMIN activo puede dar de alta empresas');
    }
    if (code === '22023') {
      return new BadRequestException('Los datos del alta no son válidos');
    }
    return error;
  }
}
