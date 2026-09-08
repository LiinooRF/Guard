import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const AQUI = __dirname;

describe('sistema visual de uso diario (#292)', () => {
  const css = readFileSync(join(AQUI, '..', 'globals.css'), 'utf8');
  const marca = readFileSync(join(AQUI, 'marca-configuracion.tsx'), 'utf8');
  const navegacionGuardia = readFileSync(join(AQUI, 'guard-bottom-nav.tsx'), 'utf8');
  const inicioGuardia = readFileSync(join(AQUI, 'guard-home.tsx'), 'utf8');
  const rondaGuardia = readFileSync(join(AQUI, 'guard-shift.tsx'), 'utf8');
  const paginaPorRol = readFileSync(join(AQUI, '..', 'app', '[role]', 'page.tsx'), 'utf8');

  it('prioriza la tipografía del sistema y superficies administrativas planas', () => {
    expect(css).toContain('font-family: -apple-system, BlinkMacSystemFont');
    expect(css).toMatch(/\.primary-button \{[^}]*background: var\(--blue\);/);
    expect(css).toMatch(/\.stat-card, \.operation-card, \.alerts-card, \.activity-card \{[^}]*border:/);
    expect(css).not.toMatch(/\.stat-card, \.operation-card, \.alerts-card, \.activity-card \{[^}]*box-shadow:/);
  });

  /**
   * En el telefono la barra del panel lleva siete secciones y entran dos: el
   * resto vive detras de un scroll horizontal. Y en movil la barra de scroll
   * es invisible, asi que un supervisor no tenia como saber que existian
   * "Monitoreo en vivo" o "Informes" — justo lo que se mira desde la calle.
   *
   * Se comprueba la tecnica y no el aspecto: las capas `local` se mueven con
   * el contenido y tapan la pista al llegar al extremo, las `scroll` quedan
   * fijas y la muestran mientras haya mas para ese lado. Si alguien quita el
   * `local`, la pista queda encendida para siempre y deja de significar algo.
   */
  it('avisa que la navegación móvil sigue hacia el costado', () => {
    const barra = css.match(/\.sidebar nav \{\s*--nav-fondo[\s\S]*?\n\}/);

    expect(barra).not.toBeNull();
    // Dos de cada una, izquierda y derecha. Contarlas y no solo buscarlas:
    // con `toContain` bastaba que sobreviviera una y el test pasaba igual.
    expect(barra![0].match(/no-repeat local/g)).toHaveLength(2);
    expect(barra![0].match(/no-repeat scroll/g)).toHaveLength(2);
    // Fondo oscuro: la pista es clara. Una sombra negra ahi no se ve.
    expect(barra![0]).toMatch(/rgb\(255 255 255/);
    // Sigue el color de la marca en white-label, no un azul fijo.
    expect(barra![0]).toContain('var(--marca-primario, var(--navy))');
  });

  it('no deja esa pista en escritorio, donde la barra es vertical', () => {
    expect(css).toMatch(
      /@media \(min-width: 901px\)[\s\S]*?\.sidebar nav \{[^}]*overflow: visible;[^}]*background: none;/,
    );
  });

  /**
   * Medido en produccion a 390 px: la vista de Planificacion empujaba la
   * PAGINA ENTERA a 1.072 px y habia que arrastrarla de lado para leer
   * cualquier cosa. El calendario ya tenia `overflow-x: auto`, pero nunca
   * llegaba a actuar: quien se desbordaba era su contenedor, que por ser hijo
   * de un grid vale `min-width: auto` y no puede achicarse por debajo de su
   * contenido.
   *
   * Es una linea facil de borrar por "limpieza" sin que nada se vea roto en
   * escritorio, que es donde se mira el CSS.
   */
  /**
   * Los bloques del panel son items de un grid, y por defecto un item de grid
   * vale `min-width: auto`: no se achica por debajo de su contenido. Cualquier
   * tabla, calendario o grafico ancho estira su bloque y el bloque estira la
   * pagina.
   *
   * Ya paso una vez, en Planificacion. Esta regla lo evita para los catorce
   * bloques a la vez en lugar de esperar a que alguien descubra el siguiente
   * desde un telefono.
   */
  it('los bloques del panel se pueden achicar en pantallas angostas', () => {
    expect(css).toMatch(/\.panel-view > \* \{[^}]*min-width: 0;/);
  });

  it('la planificación no empuja la página a lo ancho en el teléfono', () => {
    expect(css).toMatch(/\.schedule-panel \{[^}]*min-width: 0;/);
    // El calendario tiene que poder desplazarse por dentro.
    expect(css).toMatch(/\.schedule-calendar \{[^}]*overflow-x: auto;/);
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

  it('los campos de Marca usan la tipografia del panel, no la del navegador', () => {
    // Un `textarea` sin font-family cae en la monoespaciada por defecto del
    // navegador, y el pie de los correos se veia como una terminal en medio de
    // un formulario. El `input` de al lado no lo hace, asi que la diferencia
    // saltaba a la vista dentro de la misma tarjeta.
    expect(css).toMatch(/\.brand-field input, \.brand-field textarea \{[^}]*font-family: inherit;/);
  });

  it('los tonos de marca se reparten parejos, sin uno colgando solo', () => {
    // Son 8: en rejilla entran 8 en fila y 4 + 4 en el telefono. Con flex-wrap
    // quedaban 7 arriba y uno solo abajo, que se lee como un error de carga.
    expect(css).toMatch(/\.brand-color-options \{[^}]*grid-template-columns: repeat\(8, minmax\(0, 1fr\)\);/);
    expect(css).toMatch(/@media \(max-width: 520px\)[\s\S]*?\.brand-color-options \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\);/);
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

  it('separa turno, puntos y sesiones en vistas reales y marca la vigente', () => {
    expect(paginaPorRol).toContain("href: '?vista=turno'");
    expect(paginaPorRol).toContain("href: '?vista=puntos'");
    expect(paginaPorRol).toContain("href: '?vista=sesiones'");
    expect(paginaPorRol).toContain("active: guardView === 'sesiones'");
    expect(inicioGuardia).not.toContain("href: '#sesiones'");
    expect(rondaGuardia).not.toContain("href: '#sesiones'");
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
