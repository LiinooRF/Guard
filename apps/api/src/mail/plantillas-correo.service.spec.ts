import { PlantillasCorreoService } from './plantillas-correo.service';
import { LOGO_CONTENT_ID } from './plantillas-logo';
import { VAR_MARCA_LOGO_SRC, VAR_MARCA_NOMBRE, VAR_MARCA_PIE } from './plantillas-maqueta';
import { PlantillasMarcaService, type MarcaCorreo } from './plantillas-marca';
import type { OpcionesCorreo } from './plantillas-opciones';
import { renderTemplate } from './template-renderer';

const CON_HTML: OpcionesCorreo = { incluirHtml: true, logoMaxKB: 200 };
const SOLO_TEXTO: OpcionesCorreo = { incluirHtml: false, logoMaxKB: 200 };

const LOGO_BASE64 = Buffer.alloc(30).toString('base64');

function marca(cambios: Partial<MarcaCorreo> = {}): MarcaCorreo {
  return {
    nombreEmpresa: 'Seguridad Andes',
    nombreRemitente: 'Seguridad Andes',
    colorPrimario: '#1f3b73',
    colorTextoSobrePrimario: '#ffffff',
    pie: null,
    logo: null,
    motivoSinLogo: 'sin_logo',
    replyTo: null,
    fromAddressVerificada: null,
    esDeLaPlataforma: false,
    ...cambios,
  };
}

const LOGO_INCRUSTADO = {
  modo: 'incrustado' as const,
  contentType: 'image/png',
  contentBase64: LOGO_BASE64,
  filename: 'logo.png',
  bytes: 30,
  anchoPx: 120,
  dataUri: `data:image/png;base64,${LOGO_BASE64}`,
};

function servicio(): PlantillasCorreoService {
  const marcaService = {
    remitenteDeLaPlataforma: () => 'SentryCore <no-reply@sentrycore.cl>',
  } as unknown as PlantillasMarcaService;
  return new PlantillasCorreoService(marcaService);
}

describe('PlantillasCorreoService', () => {
  it('arma la invitacion con todo lo que la plantilla necesita', () => {
    const armado = servicio().armarConMarca(
      'invitacion',
      { enlace: 'https://panel.example.cl/#invite=abc', vigencia: '24 horas' },
      CON_HTML,
      marca(),
    );

    // Si faltara una variable, renderTemplate lanzaria... dentro del worker.
    // Que esto no lance es la prueba de que se atrapa antes.
    const salida = renderTemplate(armado.template, armado.variables);
    expect(salida.subject).toBe('Activa tu acceso a Seguridad Andes');
    expect(salida.html).toContain('Seguridad Andes');
    expect(armado.variables[VAR_MARCA_NOMBRE]).toBe('Seguridad Andes');
  });

  it('el sobre lleva el nombre del tenant y su direccion de respuesta', () => {
    const armado = servicio().armarConMarca(
      'recuperacion',
      { enlace: 'https://panel.example.cl/#reset=abc', vigencia: '30 minutos' },
      CON_HTML,
      marca({ replyTo: 'contacto@andes.cl' }),
    );
    expect(armado.envelope).toEqual({
      from: '"Seguridad Andes" <no-reply@sentrycore.cl>',
      replyTo: 'contacto@andes.cl',
    });
  });

  it('el logo viaja como adjunto en linea y el HTML lo referencia por cid', () => {
    const armado = servicio().armarConMarca(
      'invitacion',
      { enlace: 'https://panel.example.cl/#invite=abc', vigencia: '24 horas' },
      CON_HTML,
      marca({ logo: LOGO_INCRUSTADO, motivoSinLogo: null }),
    );

    expect(armado.variables[VAR_MARCA_LOGO_SRC]).toBe(`cid:${LOGO_CONTENT_ID}`);
    expect(armado.attachments).toEqual([
      {
        filename: 'logo.png',
        contentType: 'image/png',
        contentBase64: LOGO_BASE64,
        cid: LOGO_CONTENT_ID,
      },
    ]);
  });

  it('en la vista previa el logo va como data URI, que es lo que dibuja el navegador', () => {
    const armado = servicio().armarConMarca(
      'invitacion',
      { enlace: 'https://panel.example.cl/#invite=abc', vigencia: '24 horas' },
      CON_HTML,
      marca({ logo: LOGO_INCRUSTADO, motivoSinLogo: null }),
      'vista-previa',
    );
    expect(armado.variables[VAR_MARCA_LOGO_SRC]).toBe(LOGO_INCRUSTADO.dataUri);
    // Nada de adjuntos: la vista previa no manda correo.
    expect(armado.attachments).toEqual([]);
  });

  it('sin HTML no manda el logo adjunto: no habria donde mostrarlo', () => {
    const armado = servicio().armarConMarca(
      'invitacion',
      { enlace: 'https://panel.example.cl/#invite=abc', vigencia: '24 horas' },
      SOLO_TEXTO,
      marca({ logo: LOGO_INCRUSTADO, motivoSinLogo: null }),
    );
    expect(armado.template.html).toBeUndefined();
    expect(armado.attachments).toEqual([]);
    expect(armado.variables[VAR_MARCA_LOGO_SRC]).toBeUndefined();
  });

  it('el pie de marca entra solo cuando el tenant configuro uno', () => {
    const conPie = servicio().armarConMarca(
      'invitacion',
      { enlace: 'https://x.cl', vigencia: '24 horas' },
      CON_HTML,
      marca({ pie: 'Seguridad Andes SpA - Santiago' }),
    );
    expect(conPie.variables[VAR_MARCA_PIE]).toBe('Seguridad Andes SpA - Santiago');
    expect(renderTemplate(conPie.template, conPie.variables).text).toContain(
      'Seguridad Andes SpA - Santiago',
    );

    const sinPie = servicio().armarConMarca(
      'invitacion',
      { enlace: 'https://x.cl', vigencia: '24 horas' },
      CON_HTML,
      marca(),
    );
    expect(sinPie.variables[VAR_MARCA_PIE]).toBeUndefined();
    expect(() => renderTemplate(sinPie.template, sinPie.variables)).not.toThrow();
  });

  it('avisa al encolar, no en el worker, cuando falta una variable del informe', () => {
    expect(() =>
      servicio().armarConMarca(
        'informe-ronda',
        { recinto: 'Planta Poniente' },
        CON_HTML,
        marca(),
      ),
    ).toThrow(/faltan las variables/);
  });

  it('el mensaje de la variable faltante no filtra valores', () => {
    try {
      servicio().armarConMarca(
        'invitacion',
        { enlace: 'https://panel.example.cl/#invite=token-secreto' },
        CON_HTML,
        marca(),
      );
      throw new Error('deberia haber lanzado');
    } catch (error) {
      expect(String(error)).toContain('vigencia');
      expect(String(error)).not.toContain('token-secreto');
    }
  });
});
