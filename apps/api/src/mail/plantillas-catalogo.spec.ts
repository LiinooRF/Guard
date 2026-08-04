import { variablesInforme } from '../reports/envio-informe.plantillas';
import {
  CATALOGO_PLANTILLAS,
  CLAVES_PLANTILLA,
  construirPlantilla,
  marcadoresDe,
  type ClavePlantilla,
} from './plantillas-catalogo';
import {
  VAR_MARCA_COLOR,
  VAR_MARCA_COLOR_TEXTO,
  VAR_MARCA_LOGO_ANCHO,
  VAR_MARCA_LOGO_SRC,
  VAR_MARCA_NOMBRE,
  VAR_MARCA_PIE,
} from './plantillas-maqueta';
import { renderTemplate } from './template-renderer';

const CON_TODO = { conLogo: true, conPie: true };
const PELADA = { conLogo: false, conPie: false };

/** Variables de presentacion: solo existen en el HTML, no en el texto. */
const SOLO_HTML = new Set([VAR_MARCA_COLOR, VAR_MARCA_COLOR_TEXTO, VAR_MARCA_LOGO_SRC, VAR_MARCA_LOGO_ANCHO]);

describe('catalogo de plantillas de correo', () => {
  it.each([...CLAVES_PLANTILLA])('%s tiene version texto y version HTML', (clave) => {
    const conHtml = construirPlantilla(clave, CON_TODO, true);
    expect(conHtml.text.trim().length).toBeGreaterThan(80);
    expect(conHtml.html).toBeDefined();

    const soloTexto = construirPlantilla(clave, PELADA, false);
    expect(soloTexto.html).toBeUndefined();
    // Apagar el HTML no mutila el correo: el texto sigue siendo el mismo.
    expect(soloTexto.text.length).toBeGreaterThan(80);
  });

  it.each([...CLAVES_PLANTILLA])('%s no deja etiquetas HTML en la version de texto', (clave) => {
    const plantilla = construirPlantilla(clave, CON_TODO, true);
    expect(plantilla.text).not.toMatch(/<[a-z/][^>]*>/i);
  });

  it.each([...CLAVES_PLANTILLA])('%s no nombra a la plataforma en ningun texto', (clave) => {
    // El criterio de aceptacion del issue: el correo lleva la marca del cliente
    // y no la del revendedor. El nombre de la empresa entra por variable.
    const plantilla = construirPlantilla(clave, CON_TODO, true);
    const todo = `${plantilla.subject} ${plantilla.text} ${plantilla.html ?? ''}`;
    expect(todo).not.toMatch(/voxia/i);
    expect(todo).toContain(`{{${VAR_MARCA_NOMBRE}}}`);
  });

  it('el informe y la alerta llevan asuntos distintos', () => {
    // Si fueran iguales, la alerta se perderia entre los informes de todos los
    // dias en una bandeja llena, que es exactamente lo que hay que evitar.
    expect(CATALOGO_PLANTILLAS['informe-ronda'].asunto).not.toEqual(
      CATALOGO_PLANTILLAS['alerta-cumplimiento'].asunto,
    );
  });

  it.each([...CLAVES_PLANTILLA])(
    '%s: todo lo que pide el texto lo pide tambien el HTML',
    (clave) => {
      const conHtml = construirPlantilla(clave, CON_TODO, true);
      const soloTexto = construirPlantilla(clave, CON_TODO, false);
      const enTexto = marcadoresDe(soloTexto);
      const enHtml = new Set(marcadoresDe(conHtml));

      for (const nombre of enTexto) expect(enHtml.has(nombre)).toBe(true);

      // Y al reves: lo que solo tiene el HTML es presentacion, no contenido.
      const soloEnHtml = marcadoresDe(conHtml).filter((n) => !enTexto.includes(n));
      for (const nombre of soloEnHtml) expect(SOLO_HTML.has(nombre)).toBe(true);
    },
  );

  it('sin pie de marca la plantilla no pide la variable del pie', () => {
    // El renderer trata la variable faltante como error y lanza. Un tenant sin
    // pie configurado es lo normal, no un correo que no sale.
    const conPie = construirPlantilla('invitacion', { conLogo: false, conPie: true }, true);
    expect(marcadoresDe(conPie)).toContain(VAR_MARCA_PIE);

    const sinPie = construirPlantilla('invitacion', PELADA, true);
    expect(marcadoresDe(sinPie)).not.toContain(VAR_MARCA_PIE);
  });

  it('sin logo la plantilla no pide ni el src ni el ancho', () => {
    const sinLogo = marcadoresDe(construirPlantilla('invitacion', PELADA, true));
    expect(sinLogo).not.toContain(VAR_MARCA_LOGO_SRC);
    expect(sinLogo).not.toContain(VAR_MARCA_LOGO_ANCHO);
  });

  it.each(['informe-ronda', 'alerta-cumplimiento'] as ClavePlantilla[])(
    '%s se contenta con las variables que ya calcula variablesInforme()',
    (clave) => {
      // Cruce contra la funcion de verdad, no contra una lista copiada a mano:
      // si manana alguien le saca una variable a variablesInforme(), este test
      // se cae aca y no en el worker de correo a las tres de la mañana.
      const disponibles = new Set(
        Object.keys(
          variablesInforme({
            ruta: 'Ronda nocturna',
            recinto: 'Planta Poniente',
            sucursal: 'Sucursal Norte',
            guardia: 'Guardia de ejemplo',
            timezone: 'America/Santiago',
            inicio: null,
            cierre: null,
            compliance: {
              expected: 10,
              scanned: 6,
              clean: 6,
              pct: 60,
              missedCheckpointIds: ['a', 'b', 'c', 'd'],
              belowThreshold: true,
            },
            umbral: 70,
            novedades: 1,
            adjunto: { incluido: true, filename: 'informe.pdf', bytes: 1024, maxMB: 8 },
            pie: null,
          }),
        ),
      );
      for (const nombre of [
        VAR_MARCA_NOMBRE,
        VAR_MARCA_COLOR,
        VAR_MARCA_COLOR_TEXTO,
        VAR_MARCA_LOGO_SRC,
        VAR_MARCA_LOGO_ANCHO,
        VAR_MARCA_PIE,
      ]) {
        disponibles.add(nombre);
      }

      for (const nombre of marcadoresDe(construirPlantilla(clave, CON_TODO, true))) {
        expect(disponibles.has(nombre)).toBe(true);
      }
    },
  );

  it('el HTML no usa nada que Outlook no sepa dibujar', () => {
    const html = construirPlantilla('informe-ronda', CON_TODO, true).html ?? '';
    expect(html).not.toMatch(/display\s*:\s*(flex|grid)/i);
    expect(html).not.toMatch(/position\s*:\s*(absolute|fixed)/i);
    expect(html).not.toMatch(/background-image/i);
    // El fondo de marca va tambien en bgcolor: el style solo se pierde seguido.
    expect(html).toContain(`bgcolor="{{${VAR_MARCA_COLOR}}}"`);
    expect(html).toContain('role="presentation"');
    expect(html).toContain('name="viewport"');
    expect(html).toContain('color-scheme');
  });

  it('renderiza de punta a punta y escapa lo que viene de la empresa', () => {
    const plantilla = construirPlantilla('invitacion', { conLogo: false, conPie: true }, true);
    const salida = renderTemplate(plantilla, {
      [VAR_MARCA_NOMBRE]: 'Seguridad <Andes> & Cia',
      [VAR_MARCA_COLOR]: '#1f3b73',
      [VAR_MARCA_COLOR_TEXTO]: '#ffffff',
      [VAR_MARCA_PIE]: 'Av. Siempre Viva 742',
      enlace: 'https://panel.example.cl/#token=abc',
      vigencia: '24 horas',
    });

    expect(salida.subject).toBe('Activa tu acceso a Seguridad <Andes> & Cia');
    expect(salida.text).toContain('Seguridad <Andes> & Cia');
    expect(salida.html).toContain('Seguridad &lt;Andes&gt; &amp; Cia');
    expect(salida.html).not.toContain('<Andes>');
  });
});
