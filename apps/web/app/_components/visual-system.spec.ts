import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AQUI = __dirname;

describe('sistema visual de uso diario (#292)', () => {
  const css = readFileSync(join(AQUI, '..', 'globals.css'), 'utf8');
  const marca = readFileSync(join(AQUI, 'marca-configuracion.tsx'), 'utf8');
  const navegacionGuardia = readFileSync(join(AQUI, 'guard-bottom-nav.tsx'), 'utf8');
  const inicioGuardia = readFileSync(join(AQUI, 'guard-home.tsx'), 'utf8');
  const rondaGuardia = readFileSync(join(AQUI, 'guard-shift.tsx'), 'utf8');

  it('prioriza la tipografía del sistema y superficies administrativas planas', () => {
    expect(css).toContain('font-family: -apple-system, BlinkMacSystemFont');
    expect(css).toMatch(/\.primary-button \{[^}]*background: var\(--blue\);/);
    expect(css).toMatch(/\.stat-card, \.operation-card, \.alerts-card, \.activity-card \{[^}]*border:/);
    expect(css).not.toMatch(/\.stat-card, \.operation-card, \.alerts-card, \.activity-card \{[^}]*box-shadow:/);
  });

  it('mantiene las tres métricas en una sola franja móvil', () => {
    expect(css).toMatch(/@media \(max-width: 600px\)[\s\S]*?\.stat-grid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\);/);
  });

  it('simplifica el guardia sin reducir sus objetivos táctiles', () => {
    expect(css).toMatch(/\.dashboard-shell\[data-role="GUARDIA"\] \{[^}]*--guardia-azul: var\(--marca-secundario/);
    expect(css).toMatch(/--guardia-toque: 3rem/);
    expect(css).toMatch(/\.guardia-boton-escanear \{[^}]*min-height: 4\.75rem/);
    expect(css).toMatch(/\.guard-shift-grid \{[^}]*grid-template-columns: repeat\(3/);
    expect(css).not.toMatch(/\.guard-focus-card, \.empty-assignment \{[^}]*box-shadow/);
  });

  it('reserva espacio real bajo la navegación fija del guardia', () => {
    expect(css).toMatch(
      /\.dashboard-shell\[data-role="GUARDIA"\] \.dashboard-content \{[^}]*padding-bottom: calc\(7\.5rem \+ env\(safe-area-inset-bottom\)\)/,
    );
    expect(css).toMatch(/\.guardia-nav-inferior \{[^}]*position: fixed/);
    expect(css).toContain('bottom: max(.65rem, env(safe-area-inset-bottom))');
    expect(css).toMatch(
      /@media \(max-width: 600px\)[\s\S]*?\.dashboard-shell\[data-role="GUARDIA"\] \.dashboard-content \{ padding: \.85rem \.75rem calc\(7\.5rem \+ env\(safe-area-inset-bottom\)\); \}/,
    );
  });

  it('la navegación inferior tiene estado activo, foco y movimiento reducible', () => {
    expect(navegacionGuardia).toContain("aria-label=\"Navegación del turno\"");
    expect(navegacionGuardia).toContain("aria-current={item.active ? 'page' : undefined}");
    expect(css).toContain('.guardia-nav-item:focus-visible');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.guardia-nav-inferior \{ animation: none; \}/);
  });

  it('mantiene las sesiones reales localizables durante todo el turno', () => {
    expect(inicioGuardia).toContain("href: '#sesiones'");
    expect(rondaGuardia).toContain("href: '#sesiones'");
    expect(navegacionGuardia).toContain("name === 'sesiones'");
    expect(css).toMatch(/\.dashboard-shell\[data-role="GUARDIA"\] #sesiones \.secondary-button \{[^}]*min-height: var\(--guardia-toque\)/);
  });
  it('Marca tiene grupos comprensibles, vista previa real y mensajes accesibles', () => {
    expect(marca).toContain('id="marca-identidad"');
    expect(marca).toContain('id="marca-colores"');
    expect(marca).toContain('id="marca-correo"');
    expect(marca).toContain('className="brand-preview-window"');
    expect(marca).toContain('aria-live="polite"');
    expect(marca).toContain('COLORES_DE_MARCA.map');
    expect(marca).toContain('aria-pressed=');
    expect(marca).not.toContain('type="color"');
  });
});
