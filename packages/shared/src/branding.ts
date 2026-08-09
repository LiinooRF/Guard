import { z } from 'zod';

/**
 * Marca por tenant. Vive en el contrato compartido porque la consumen los tres:
 * la API la sirve, la web pinta con ella y el PDF la estampa.
 */
export const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'El color debe ser HEX de 6 dígitos, por ejemplo #1f3b73');

export const tenantBrandingSchema = z.object({
  commercialName: z.string().min(2).max(80).nullable().default(null),
  logoUri: z.string().max(2_000_000).nullable().default(null),
  primaryColor: hexColor.default('#1f3b73'),
  primaryTextColor: hexColor.default('#ffffff'),
  secondaryColor: hexColor.default('#4263eb'),
  mailFromName: z.string().min(2).max(80).nullable().default(null),
  mailFooter: z.string().max(500).nullable().default(null),
});
export type TenantBranding = z.infer<typeof tenantBrandingSchema>;

/** Luminancia relativa segun WCAG 2.1. */
function luminancia(hex: string): number {
  const canal = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(0) + 0.7152 * canal(1) + 0.0722 * canal(2);
}

/** Razon de contraste entre dos colores: 1 (iguales) a 21 (negro sobre blanco). */
export function contrastRatio(a: string, b: string): number {
  const la = luminancia(a);
  const lb = luminancia(b);
  const claro = Math.max(la, lb);
  const oscuro = Math.min(la, lb);
  return (claro + 0.05) / (oscuro + 0.05);
}

/**
 * WCAG AA exige 4.5:1 para texto normal. Un color de marca bonito pero claro
 * deja botones ilegibles, y el admin que lo eligio no se entera hasta que un
 * guardia no encuentra el boton de panico a las 3 de la mañana.
 */
export const MIN_CONTRAST_AA = 4.5;

export interface ContrastCheck {
  /** Contraste del color de marca SOBRE EL FONDO BLANCO de la aplicacion. */
  readonly onSurface: number;
  /** Si sirve para texto, iconos y bordes sobre ese fondo. */
  readonly passes: boolean;
  /** Texto que contrasta cuando el color se usa como RELLENO (boton, cabecera). */
  readonly fillText: '#ffffff' | '#111111';
  readonly fillRatio: number;
}

/**
 * Mide contra el fondo blanco de la aplicacion, no "el mejor entre blanco y
 * negro".
 *
 * Eso ultimo parece razonable y es inutil: el maximo de ambos nunca baja de
 * ~4.35, asi que ningun color reprobaria jamas. El caso real que hay que
 * atajar es el color claro —un amarillo de marca da 1.3 contra blanco— usado
 * para texto, iconos y bordes sobre las superficies claras del panel.
 *
 * Como RELLENO ese mismo amarillo si sirve, con texto oscuro encima: por eso
 * se devuelven las dos medidas y solo `passes` bloquea.
 */
export function checkContrast(color: string): ContrastCheck {
  const onSurface = contrastRatio(color, '#ffffff');
  const contraNegro = contrastRatio(color, '#111111');
  const usaBlanco = onSurface >= contraNegro;
  const redondear = (v: number) => Math.round(v * 100) / 100;
  return {
    onSurface: redondear(onSurface),
    passes: onSurface >= MIN_CONTRAST_AA,
    fillText: usaBlanco ? '#ffffff' : '#111111',
    fillRatio: redondear(usaBlanco ? onSurface : contraNegro),
  };
}

/**
 * Variables CSS que la web inyecta en el servidor. Se resuelven ANTES de pintar
 * para que no se vea un instante con la marca equivocada: ese parpadeo, en un
 * producto white-label, es el cliente viendo la marca de otro.
 */
export function brandingCssVariables(branding: TenantBranding): Record<string, string> {
  const secundario = checkContrast(branding.secondaryColor);
  return {
    '--marca-primario': branding.primaryColor,
    '--marca-primario-texto': branding.primaryTextColor,
    '--marca-secundario': branding.secondaryColor,
    '--marca-secundario-texto': secundario.fillText,
  };
}
