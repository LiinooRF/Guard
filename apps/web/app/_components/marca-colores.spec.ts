import { checkContrast, MIN_CONTRAST_AA } from '@voxia/shared';

import { COLORES_DE_MARCA } from './marca-colores';

describe('paleta accesible de marca', () => {
  it.each(COLORES_DE_MARCA)('$nombre ($valor) cumple contraste AA sobre blanco', ({ valor }) => {
    const contraste = checkContrast(valor);

    expect(contraste.onSurface).toBeGreaterThanOrEqual(MIN_CONTRAST_AA);
    expect(contraste.passes).toBe(true);
  });
});

