import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { logoParaEnviar, validarLogo, MAX_LOGO_BYTES } from './marca-logo';

/**
 * White-label por empresa (#117): la mitad WEB, que era la que faltaba.
 *
 * La API servia `GET /branding` con el tema listo, el contrato traia
 * `brandingCssVariables` y `checkContrast`, `globals.css` ya leia
 * `var(--marca-primario, ...)` con fallback... y `git grep branding apps/web`
 * daba CERO. Cable numero 11 de la familia "construido, correcto e
 * inalcanzable". Por eso este spec, como el de #275, tiene dos mitades: la
 * logica y el CABLEADO — la que falta en produccion es siempre la segunda.
 */

describe('validarLogo', () => {
  it.each(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])(
    'acepta %s dentro del peso',
    (tipo) => {
      expect(validarLogo(tipo, 10_000)).toEqual({ valido: true });
    },
  );

  it('rechaza el formato que no se dibuja en todos los telefonos', () => {
    const veredicto = validarLogo('image/tiff', 10_000);
    expect(veredicto.valido).toBe(false);
  });

  it('rechaza el logo pesado ANTES de subirlo, con el peso en el mensaje', () => {
    // El contrato admite 2 MB porque es el techo de la BASE; el objetivo es
    // otro: el logo viaja en cada GET /branding, tambien al telefono del
    // guardia con datos moviles.
    const veredicto = validarLogo('image/png', MAX_LOGO_BYTES + 1);
    expect(veredicto.valido).toBe(false);
    if (!veredicto.valido) {
      expect(veredicto.motivo).toContain('KB');
    }
  });
});

describe('logoParaEnviar', () => {
  const actual = 'data:image/png;base64,VIEJO';
  const nuevo = 'data:image/png;base64,NUEVO';

  it('sin cambios conserva el logo actual', () => {
    expect(logoParaEnviar({ actual, nuevo: null, quitar: false })).toBe(actual);
  });

  it('con archivo nuevo lo reemplaza', () => {
    expect(logoParaEnviar({ actual, nuevo, quitar: false })).toBe(nuevo);
  });

  it('quitar gana sobre todo: null BORRA el logo en el PUT', () => {
    // El PUT reemplaza el registro completo: mandar null es borrar, no
    // "sin cambio". La funcion existe para que esa semantica quede escrita.
    expect(logoParaEnviar({ actual, nuevo, quitar: true })).toBeNull();
  });
});

describe('el cableado: que esta vez SI lo pinte alguien', () => {
  const componente = (nombre: string) => readFileSync(join(__dirname, nombre), 'utf8');
  const pagina = (ruta: string) => readFileSync(join(__dirname, '..', ruta), 'utf8');

  it('el shell recibe la marca y deja caer las variables CSS', () => {
    const fuente = componente('dashboard-shell.tsx');
    expect(fuente).toContain('MarcaDelShell');
    expect(fuente).toContain('cssVariables');
    expect(fuente).toContain('data-role={role}');
    // Y la pasa a la esquina de la marca, no solo al estilo.
    expect(fuente).toMatch(/<Brand[^>]*logoUri=/);
  });

  it('las pantallas del panel resuelven la marca EN EL SERVIDOR', () => {
    for (const ruta of ['app/[role]/page.tsx', 'app/[role]/mapa/page.tsx']) {
      const fuente = pagina(ruta);
      expect(fuente).toContain('marcaDelTenant()');
      expect(fuente).toMatch(/<DashboardShell[^>]*\n?[^>]*marca=/);
    }
  });

  it('el ADMIN tiene el editor montado y con entrada en el menu', () => {
    expect(pagina('app/[role]/page.tsx')).toContain('<MarcaConfiguracion');
    expect(componente('panel-navigation.ts')).toContain("view: 'marca'");
  });

  it('guardar reconcilia automáticamente el shell servido por Next', () => {
    const fuente = componente('marca-configuracion.tsx');
    expect(fuente).toContain('aplicarColoresGuardados(shell.style');
    expect(fuente).toContain('router.refresh()');
    expect(fuente).not.toContain('Los cambios se aplican al volver a cargar.');
  });

  it('la hoja de estilos dibuja el logo del tenant con la misma caja que la marca propia', () => {
    const css = readFileSync(join(__dirname, '..', 'globals.css'), 'utf8');
    expect(css).toContain('.brand-logo');
    expect(css).toContain('.dashboard-shell[data-role="ADMIN"] .sidebar');
    // La operación de terreno queda fuera de esta personalización del panel.
    expect(css).not.toContain('.dashboard-shell[data-role="GUARDIA"] .sidebar');
  });
});
