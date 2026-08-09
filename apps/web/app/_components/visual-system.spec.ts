import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AQUI = __dirname;

describe('sistema visual de uso diario (#292)', () => {
  const css = readFileSync(join(AQUI, '..', 'globals.css'), 'utf8');
  const marca = readFileSync(join(AQUI, 'marca-configuracion.tsx'), 'utf8');

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
