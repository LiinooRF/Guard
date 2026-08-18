import { PANEL_NAVIGATION, panelViewCopy, resolvePanelView } from './panel-navigation';

describe('arquitectura de vistas del panel (#289)', () => {
  it.each(['ADMIN', 'SUPERVISOR', 'SUPERADMIN'] as const)(
    '%s tiene vistas únicas y una entrada de resumen',
    (role) => {
      const views = PANEL_NAVIGATION[role].flatMap((group) => group.items.map((item) => item.view));
      expect(new Set(views).size).toBe(views.length);
      expect(views).toContain('resumen');
    },
  );

  it('una vista desconocida cae al resumen sin montar un panel inventado', () => {
    expect(resolvePanelView('ADMIN', 'todo-junto')).toBe('resumen');
    expect(resolvePanelView('SUPERVISOR', undefined)).toBe('resumen');
  });

  it('cada enlace tiene un encabezado propio', () => {
    for (const role of ['ADMIN', 'SUPERVISOR', 'SUPERADMIN'] as const) {
      for (const group of PANEL_NAVIGATION[role]) {
        for (const item of group.items) {
          const copy = panelViewCopy(role, item.view);
          expect(copy.title).toBeTruthy();
          expect(copy.subtitle).toBeTruthy();
        }
      }
    }
  });

  it('el guardia no entra en el catálogo de paneles administrativos', () => {
    expect(Object.keys(PANEL_NAVIGATION)).not.toContain('GUARDIA');
  });

  /**
   * #309. La pantalla de puntos y etiquetas necesita las DOS entradas —la del
   * menu y la del encabezado— o `resolvePanelView` la manda a 'resumen' y queda
   * inalcanzable aunque la API la acepte. Y el ADMIN NO la tiene: el sigue
   * entrando por 'recintos', que ademas administra el recinto entero.
   *
   * Que el menu no la muestre no seria control de acceso: quien autoriza es el
   * servidor. Esto solo vigila que la funcion sea alcanzable.
   */
  it('el supervisor alcanza la vista de puntos y etiquetas, y el admin sigue en recintos', () => {
    expect(resolvePanelView('SUPERVISOR', 'terreno')).toBe('terreno');
    expect(panelViewCopy('SUPERVISOR', 'terreno').title).toBe('Puntos y etiquetas');
    expect(resolvePanelView('ADMIN', 'terreno')).toBe('resumen');
    expect(resolvePanelView('SUPERVISOR', 'recintos')).toBe('resumen');
  });
});
