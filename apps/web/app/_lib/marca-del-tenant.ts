import { cookies } from 'next/headers';
import type { CSSProperties } from 'react';

import type { ContrastCheck, TenantBranding } from '@sentrycore/shared';
import { brandingCssVariables, tenantBrandingSchema } from '@sentrycore/shared';

/**
 * La marca del tenant, resuelta EN EL SERVIDOR antes del primer render (#117).
 *
 * La mitad que faltaba del white-label: la API sirve `GET /branding` con el
 * tema listo para pintar, el contrato compartido trae las variables CSS y el
 * chequeo de contraste, las plantillas de correo ya estampan la marca... y el
 * panel nunca lo pedia. `git grep branding apps/web` daba cero. Emparejado el
 * 8-ago-2026 — cable numero 11 de la familia "construido, correcto e
 * inalcanzable".
 *
 * Se resuelve en el servidor y no en el navegador por la razon que la propia
 * API documenta: pedirlo desde el cliente pinta un instante con la marca
 * equivocada, y ese parpadeo en un producto white-label es el cliente viendo
 * la marca de otro.
 */

export interface MarcaDelTenant {
  branding: TenantBranding;
  /** `--marca-primario` y compania; `globals.css` ya las lee con fallback. */
  cssVariables: Record<string, string>;
  contrast: { primary: ContrastCheck; secondary: ContrastCheck } | null;
}

/** Los defaults del producto: lo que se ve sin fila de marca o sin sesion. */
export function marcaPorDefecto(): MarcaDelTenant {
  const branding = tenantBrandingSchema.parse({});
  return { branding, cssVariables: brandingCssVariables(branding), contrast: null };
}

/**
 * Pide el tema a la API con la cookie de la sesion. Falla BLANDO: sin sesion,
 * sin fila o con la API caida se responde el default del producto — la pantalla
 * de un cliente puede quedar sin su logo un rato, nunca rota.
 */
export async function marcaDelTenant(): Promise<MarcaDelTenant> {
  const galletas = await cookies();
  const acceso = galletas.get('sentrycore_access');
  if (!acceso) return marcaPorDefecto();

  const base = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? '/api';
  try {
    const respuesta = await fetch(`${base}/branding`, {
      headers: { cookie: `sentrycore_access=${acceso.value}` },
      cache: 'no-store',
    });
    if (!respuesta.ok) return marcaPorDefecto();
    const cuerpo = (await respuesta.json()) as {
      branding?: unknown;
      cssVariables?: Record<string, string>;
      contrast?: MarcaDelTenant['contrast'];
    };
    const branding = tenantBrandingSchema.parse(cuerpo.branding ?? {});
    return {
      branding,
      // Las variables se recalculan aca aunque la API las mande: son UN origen
      // (el contrato compartido) y asi una API vieja no puede dejar el panel
      // con la mitad de las variables.
      cssVariables: brandingCssVariables(branding),
      contrast: cuerpo.contrast ?? null,
    };
  } catch {
    return marcaPorDefecto();
  }
}

/**
 * Las variables CSS como estilo inline del contenedor del panel. Los nombres
 * `--marca-*` son propiedades custom validas en `CSSProperties` via indice.
 */
export function estiloDeMarca(marca: MarcaDelTenant): CSSProperties {
  return marca.cssVariables as CSSProperties;
}
