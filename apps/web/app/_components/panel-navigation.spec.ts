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
});
