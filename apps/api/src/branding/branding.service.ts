import { BadRequestException, Injectable } from '@nestjs/common';
import {
  brandingCssVariables,
  checkContrast,
  contrastRatio,
  MIN_CONTRAST_AA,
  tenantBrandingSchema,
  type TenantBranding,
} from '@voxia/shared';

import { TenantContextService } from '../database/tenant-context/tenant-context.service';

interface BrandingRow {
  commercial_name: string | null;
  logo_uri: string | null;
  primary_color: string;
  primary_text_color: string;
  secondary_color: string;
  mail_from_name: string | null;
  mail_footer: string | null;
}

@Injectable()
export class BrandingService {
  constructor(private readonly tenantContext: TenantContextService) {}

  /** La marca del tenant actual; sin fila, los defaults del producto. */
  async current(): Promise<TenantBranding> {
    const filas = await this.tenantContext.manager.query<BrandingRow[]>(
      `SELECT commercial_name, logo_uri, primary_color, primary_text_color, secondary_color,
              mail_from_name, mail_footer
       FROM tenant_branding
       WHERE tenant_id = app_tenant_id()`,
    );
    const fila = filas[0];
    if (!fila) return tenantBrandingSchema.parse({});
    return tenantBrandingSchema.parse({
      commercialName: fila.commercial_name,
      logoUri: fila.logo_uri,
      primaryColor: fila.primary_color,
      primaryTextColor: fila.primary_text_color,
      secondaryColor: fila.secondary_color,
      mailFromName: fila.mail_from_name,
      mailFooter: fila.mail_footer,
    });
  }

  /**
   * El tema resuelto para pintar: variables CSS mas el diagnostico de contraste.
   * La web lo pide EN EL SERVIDOR antes del primer render — si lo pidiera desde
   * el navegador se veria un instante con la marca equivocada, que en un
   * producto white-label es el cliente viendo la marca de otro.
   */
  async theme() {
    const marca = await this.current();
    return {
      branding: marca,
      cssVariables: brandingCssVariables(marca),
      contrast: {
        primary: checkContrast(marca.primaryColor),
        secondary: checkContrast(marca.secondaryColor),
      },
    };
  }

  async replace(input: Partial<TenantBranding>) {
    const marca = tenantBrandingSchema.parse(input);

    // Un color de marca de bajo contraste no se guarda: el admin lo elige una
    // vez y lo sufre todo el equipo. Se rechaza con el ratio y la sugerencia.
    for (const [campo, color] of [
      ['primaryColor', marca.primaryColor],
      ['secondaryColor', marca.secondaryColor],
    ] as const) {
      const chequeo = checkContrast(color);
      if (!chequeo.passes) {
        throw new BadRequestException(
          `El color ${campo} (${color}) tiene contraste ${chequeo.onSurface}:1 sobre fondo ` +
            `blanco y se necesita 4.5:1. Asi de claro no se lee como texto ni como icono en el ` +
            `panel: elige un tono mas oscuro.`,
        );
      }
    }

    const contrasteTexto = contrastRatio(marca.primaryColor, marca.primaryTextColor);
    if (contrasteTexto < MIN_CONTRAST_AA) {
      throw new BadRequestException(
        `El texto (${marca.primaryTextColor}) tiene contraste ${contrasteTexto.toFixed(2)}:1 ` +
          `sobre el color principal (${marca.primaryColor}) y se necesita 4.5:1. Elige una ` +
          `sugerencia más clara.`,
      );
    }

    await this.tenantContext.manager.query(
      `INSERT INTO tenant_branding (
        tenant_id, commercial_name, logo_uri, primary_color, primary_text_color,
        secondary_color, mail_from_name, mail_footer
      ) VALUES (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_id) DO UPDATE SET
        commercial_name = EXCLUDED.commercial_name,
        logo_uri = EXCLUDED.logo_uri,
        primary_color = EXCLUDED.primary_color,
        primary_text_color = EXCLUDED.primary_text_color,
        secondary_color = EXCLUDED.secondary_color,
        mail_from_name = EXCLUDED.mail_from_name,
        mail_footer = EXCLUDED.mail_footer,
        updated_at = now()`,
      [
        marca.commercialName,
        marca.logoUri,
        marca.primaryColor,
        marca.primaryTextColor,
        marca.secondaryColor,
        marca.mailFromName,
        marca.mailFooter,
      ],
    );
    return this.theme();
  }

  /**
   * La marca para estampar en informes y correos (#118). Cae al nombre legal
   * del tenant si no hay nombre comercial: un informe sin marca es peor que uno
   * con la marca legal.
   */
  async forDocuments() {
    const marca = await this.current();
    // display_name y legal_name, no "name": esa columna no existe en tenants y
    // el SELECT reventaba TODOS los informes en runtime. El test no lo vio
    // porque el mock devolvia una columna inventada.
    const filas = await this.tenantContext.manager.query<
      Array<{ display_name: string | null; legal_name: string | null }>
    >(`SELECT display_name, legal_name FROM tenants WHERE id = app_tenant_id()`);
    // Cascada de mas comercial a mas formal: la marca configurada, el nombre
    // con que la plataforma muestra a la empresa, y recien despues el legal.
    const nombreLegal = filas[0]?.display_name ?? filas[0]?.legal_name ?? 'VoxIA Control';
    return {
      displayName: marca.commercialName ?? nombreLegal,
      logoUri: marca.logoUri,
      primaryColor: marca.primaryColor,
      mailFromName: marca.mailFromName ?? marca.commercialName ?? nombreLegal,
      mailFooter: marca.mailFooter,
    };
  }
}
