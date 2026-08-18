import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { checkContrast, tenantBrandingSchema } from '@sentrycore/shared';
import type { EntityManager } from 'typeorm';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';
import {
  resolverLogo,
  type LogoCorreo,
  type MotivoSinLogo,
} from './plantillas-logo';

/**
 * La marca con la que sale cada correo del tenant (#42).
 *
 * Hasta ahora las plantillas decian "SentryCore" con nombre y apellido
 * (ver auth/mail.service.ts). En un producto white-label eso es el correo del
 * REVENDEDOR llegandole al cliente final, que es justo lo que el issue pide
 * arreglar: la empresa de seguridad le vende el servicio a su cliente con su
 * marca, y el correo la contradecia.
 *
 * De donde sale cada cosa, de lo mas comercial a lo mas formal:
 *   nombre visible  -> tenant_branding.mail_from_name
 *                   -> tenant_branding.commercial_name
 *                   -> tenants.display_name
 *                   -> tenants.legal_name
 *                   -> nombre del remitente de la plataforma (MAIL_FROM)
 *
 * COLUMNAS VERIFICADAS CONTRA LAS MIGRACIONES, NO CONTRA UN MOCK:
 *   tenants               -> id, display_name, legal_name (1722350000000)
 *   tenant_branding       -> commercial_name, logo_uri, primary_color,
 *                            mail_from_name, mail_footer (1724857200000)
 *   tenant_mail_sender    -> reply_to, from_address,
 *                            from_address_verified_at    (1725559200000)
 * `tenants.name` NO EXISTE. Ese SELECT ya rompio todos los informes una vez, con
 * la CI en verde, porque el mock devolvia la columna inventada.
 */

export interface MarcaCorreo {
  /** Como se llama la empresa para el cliente que abre el correo. */
  readonly nombreEmpresa: string;
  /** Nombre visible del remitente. Casi siempre igual al anterior. */
  readonly nombreRemitente: string;
  readonly colorPrimario: string;
  /** Texto que contrasta sobre el color primario usado como relleno. */
  readonly colorTextoSobrePrimario: '#ffffff' | '#111111';
  readonly pie: string | null;
  readonly logo: LogoCorreo | null;
  readonly motivoSinLogo: MotivoSinLogo | null;
  readonly replyTo: string | null;
  /**
   * Direccion propia del tenant SOLO si la plataforma ya la acredito. Sin
   * verificar va null y el correo sale con la direccion de la plataforma: ver
   * el comentario largo de la migracion 1725559200000.
   */
  readonly fromAddressVerificada: string | null;
  /** true cuando no hubo contexto de tenant y se cayo a la plataforma. */
  readonly esDeLaPlataforma: boolean;
}

interface FilaMarca {
  /** El tenant del contexto. Solo se usa para poder identificarlo en un log. */
  tenant_id: string;
  display_name: string | null;
  legal_name: string | null;
  commercial_name: string | null;
  logo_uri: string | null;
  primary_color: string | null;
  mail_from_name: string | null;
  mail_footer: string | null;
  reply_to: string | null;
  from_address: string | null;
  from_address_verified_at: Date | null;
}

const DEFAULTS_MARCA = tenantBrandingSchema.parse({});

@Injectable()
export class PlantillasMarcaService {
  private readonly logger = new Logger(PlantillasMarcaService.name);

  constructor(
    private readonly tenantContext: TenantContextService,
    private readonly config: ConfigService,
  ) {}

  /**
   * La marca del tenant del contexto actual.
   *
   * `logoMaxKB` viene de rules.ts (`mailLogoMaxKB`) y se pide explicito: sin
   * numero no hay como decidir si el logo viaja, y un default aca seria una
   * regla de negocio escondida en el codigo.
   */
  async resolver(logoMaxKB: number): Promise<MarcaCorreo> {
    const manager = this.managerONull();
    if (!manager) return this.deLaPlataforma();

    const filas = await manager.query<FilaMarca[]>(
      `SELECT t.id AS tenant_id,
              t.display_name,
              t.legal_name,
              b.commercial_name,
              b.logo_uri,
              b.primary_color,
              b.mail_from_name,
              b.mail_footer,
              s.reply_to,
              s.from_address,
              s.from_address_verified_at
       FROM tenants t
       LEFT JOIN tenant_branding b ON b.tenant_id = t.id
       LEFT JOIN tenant_mail_sender s ON s.tenant_id = t.id
       WHERE t.id = app_tenant_id()`,
    );

    const fila = filas[0];
    if (!fila) return this.deLaPlataforma();

    const nombreEmpresa =
      primeroConTexto([
        fila.commercial_name,
        fila.display_name,
        fila.legal_name,
      ]) ?? this.nombreDeLaPlataforma();

    const colorPrimario = fila.primary_color ?? DEFAULTS_MARCA.primaryColor;
    const { logo, motivo } = resolverLogo(fila.logo_uri, logoMaxKB);

    if (motivo !== null && motivo !== 'sin_logo') {
      // Con tenant_id y motivo, y nada mas. El tenant_id es lo que convierte el
      // aviso en accionable: sin el, operaciones ve que ALGUN cliente tiene el
      // logo en un formato que no se puede incrustar y no puede ir a avisarle.
      // Lo pide CLAUDE.md ("los logs llevan tenant_id y request_id") y es lo que
      // ya hacen mail.processor.ts, nodemailer-mail-provider.ts y
      // envio-informe.service.ts. NO va el logo_uri ni el nombre de la empresa.
      this.logger.warn(
        JSON.stringify({ event: 'correo_sin_logo', tenant_id: fila.tenant_id, motivo }),
      );
    }

    return {
      nombreEmpresa,
      nombreRemitente:
        primeroConTexto([fila.mail_from_name]) ?? nombreEmpresa,
      colorPrimario,
      colorTextoSobrePrimario: checkContrast(colorPrimario).fillText,
      pie: primeroConTexto([fila.mail_footer]),
      logo,
      motivoSinLogo: motivo,
      replyTo: primeroConTexto([fila.reply_to]),
      // La verificacion es la unica que habilita la direccion propia. Sin fecha
      // de verificacion la direccion guardada es una intencion, no un permiso.
      fromAddressVerificada:
        fila.from_address_verified_at === null ? null : primeroConTexto([fila.from_address]),
      esDeLaPlataforma: false,
    };
  }

  /**
   * La marca de la plataforma. Se usa cuando no hay contexto de tenant, que hoy
   * pasa en UN caso real: el endpoint publico de recuperacion de contraseña
   * corre con @SkipTenantContext y por lo tanto sin transaccion ni RLS.
   *
   * Se devuelve algo coherente en vez de lanzar: un correo de recuperacion que
   * no sale por falta de marca deja a una persona sin poder entrar.
   */
  deLaPlataforma(): MarcaCorreo {
    const nombre = this.nombreDeLaPlataforma();
    return {
      nombreEmpresa: nombre,
      nombreRemitente: nombre,
      colorPrimario: DEFAULTS_MARCA.primaryColor,
      colorTextoSobrePrimario: checkContrast(DEFAULTS_MARCA.primaryColor).fillText,
      pie: null,
      logo: null,
      motivoSinLogo: 'sin_logo',
      replyTo: null,
      fromAddressVerificada: null,
      esDeLaPlataforma: true,
    };
  }

  /** MAIL_FROM tal como lo dejo operaciones. Puede venir con o sin nombre. */
  remitenteDeLaPlataforma(): string {
    return this.config.get<string>('MAIL_FROM', 'SentryCore <no-reply@localhost>');
  }

  private nombreDeLaPlataforma(): string {
    return nombreDeRemitente(this.remitenteDeLaPlataforma());
  }

  /**
   * El manager del contexto tenant, o null si no hay transaccion abierta.
   *
   * TenantContextService.manager lanza cuando no hay contexto y no expone una
   * forma de preguntarlo. El try/catch es la unica manera de consultarlo sin
   * tocar ese archivo, que es de otro carril.
   */
  private managerONull(): EntityManager | null {
    try {
      return this.tenantContext.manager;
    } catch {
      return null;
    }
  }
}

/** El primer valor con texto de verdad. Cadena en blanco no cuenta. */
function primeroConTexto(valores: ReadonlyArray<string | null | undefined>): string | null {
  for (const valor of valores) {
    const limpio = (valor ?? '').trim();
    if (limpio.length > 0) return limpio;
  }
  return null;
}

/**
 * El nombre visible de un remitente `Nombre <buzon@dominio>`. Sin nombre
 * devuelve la parte local del correo, que es lo unico presentable que queda.
 */
export function nombreDeRemitente(remitente: string): string {
  const crudo = remitente.trim();
  const conNombre = /^(.*?)<[^>]+>\s*$/.exec(crudo);
  const nombre = (conNombre?.[1] ?? '').trim().replace(/^"|"$/g, '').trim();
  if (nombre.length > 0) return nombre;

  const direccion = direccionDeRemitente(crudo);
  const local = direccion.split('@')[0] ?? direccion;
  return local.length > 0 ? local : crudo;
}

/** La direccion de un remitente `Nombre <buzon@dominio>` o `buzon@dominio`. */
export function direccionDeRemitente(remitente: string): string {
  const crudo = remitente.trim();
  const entreAngulos = /<([^>]+)>\s*$/.exec(crudo);
  return (entreAngulos?.[1] ?? crudo).trim();
}
