import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AQUI = __dirname;

describe('navegación de los paneles (#287)', () => {
  it('mantiene la navegación fuera del carril simplificado del guardia', () => {
    const shell = readFileSync(join(AQUI, 'dashboard-shell.tsx'), 'utf8');

    expect(shell).toContain("streamlined ? (");
    expect(shell).toContain('className="guard-nav-note"');
    expect(shell).toContain('className="panel-navigation"');
    expect(shell.indexOf('className="guard-nav-note"')).toBeLessThan(
      shell.indexOf('className="panel-navigation"'),
    );
  });

  it('no vuelve a ocultar la navegación compacta bajo 901 px', () => {
    const css = readFileSync(join(AQUI, '..', 'globals.css'), 'utf8');
    const base = css.slice(0, css.indexOf('@media (min-width: 901px)'));

    expect(base).toMatch(/\.sidebar nav \{ display: flex;/);
    expect(base).toMatch(/\.sidebar nav \{[^}]*overflow-x: auto;/);
    expect(base).not.toMatch(/\.sidebar nav \{[^}]*display: none;/);
  });
});
