import { brandingCssVariables, type TenantBranding } from '@voxia/shared';

type EstiloConVariables = Pick<CSSStyleDeclaration, 'setProperty'>;

/** Aplica inmediatamente al shell los colores que el servidor ya confirmó. */
export function aplicarColoresGuardados(estilo: EstiloConVariables, marca: TenantBranding) {
  for (const [propiedad, valor] of Object.entries(brandingCssVariables(marca))) {
    estilo.setProperty(propiedad, valor);
  }
}

