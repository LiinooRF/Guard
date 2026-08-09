import { checkContrast, contrastRatio, MIN_CONTRAST_AA } from '@voxia/shared';

import { COLORES_DE_MARCA, COLORES_DE_TEXTO } from './marca-colores';

describe('paleta accesible de marca', () => {
  it.each(COLORES_DE_MARCA)('$nombre ($valor) cumple contraste AA sobre blanco', ({ valor }) => {
    const contraste = checkContrast(valor);

    expect(contraste.onSurface).toBeGreaterThanOrEqual(MIN_CONTRAST_AA);
    expect(contraste.passes).toBe(true);
  });

  it.each(COLORES_DE_MARCA)('$nombre admite todas las sugerencias de texto', ({ valor: fondo }) => {
    for (const texto of COLORES_DE_TEXTO) {
      expect(contrastRatio(fondo, texto.valor)).toBeGreaterThanOrEqual(MIN_CONTRAST_AA);
    }
  });
});
