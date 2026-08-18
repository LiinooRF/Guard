import { direccionDeRemitente, nombreDeRemitente, type MarcaCorreo } from './plantillas-marca';
import { construirSobre, nombreParaCabecera } from './plantillas-sobre';

const PLATAFORMA = 'SentryCore <no-reply@sentrycore.cl>';

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

describe('construirSobre', () => {
  it('pone el nombre del tenant sobre la direccion de la plataforma', () => {
    expect(construirSobre(marca(), PLATAFORMA)).toEqual({
      from: '"Seguridad Andes" <no-reply@sentrycore.cl>',
    });
  });

  it('agrega el Reply-To de la empresa cuando esta configurado', () => {
    expect(construirSobre(marca({ replyTo: 'contacto@seguridadandes.cl' }), PLATAFORMA)).toEqual({
      from: '"Seguridad Andes" <no-reply@sentrycore.cl>',
      replyTo: 'contacto@seguridadandes.cl',
    });
  });

  it('NO usa la direccion propia del tenant mientras no este verificada', () => {
    // Es la proteccion contra suplantacion entre empresas del mismo SaaS: la
    // marca solo trae la direccion cuando la plataforma acredito el dominio.
    const sinVerificar = marca({ fromAddressVerificada: null });
    expect(construirSobre(sinVerificar, PLATAFORMA).from).toContain('no-reply@sentrycore.cl');
  });

  it('usa la direccion propia una vez verificada', () => {
    const verificada = marca({ fromAddressVerificada: 'avisos@seguridadandes.cl' });
    expect(construirSobre(verificada, PLATAFORMA).from).toBe(
      '"Seguridad Andes" <avisos@seguridadandes.cl>',
    );
  });

  it('descarta un Reply-To que no tiene forma de direccion', () => {
    const sobre = construirSobre(marca({ replyTo: 'no-es-un-correo' }), PLATAFORMA);
    expect(sobre.replyTo).toBeUndefined();
  });

  it('funciona con un MAIL_FROM sin nombre visible', () => {
    expect(construirSobre(marca(), 'no-reply@localhost').from).toBe(
      '"Seguridad Andes" <no-reply@localhost>',
    );
  });
});

describe('nombreParaCabecera', () => {
  it('no deja inyectar cabeceras con un salto de linea', () => {
    const conSalto = ['Empresa', 'Bcc: espia@example.cl'].join('\r\n');
    const nombre = nombreParaCabecera(conSalto);
    expect(nombre).not.toContain('\n');
    expect(nombre).not.toContain('\r');
    expect(nombre).toBe('"Empresa Bcc: espia@example.cl"');
  });

  it('saca los angulos para que el nombre no parezca otra direccion', () => {
    expect(nombreParaCabecera('soporte@banco.cl <x@y.cl>')).toBe('"soporte@banco.cl x@y.cl"');
  });

  it('escapa comillas y barras invertidas en vez de romper el entrecomillado', () => {
    expect(nombreParaCabecera('Andes "la buena" \\ Ltda')).toBe(
      '"Andes \\"la buena\\" \\\\ Ltda"',
    );
  });

  it('conserva guiones, acentos y eñes', () => {
    expect(nombreParaCabecera('Seguridad Ñuñoa - Maipú')).toBe('"Seguridad Ñuñoa - Maipú"');
  });

  it('un nombre en blanco no deja una cabecera con comillas vacias', () => {
    expect(nombreParaCabecera('   ')).toBe('');
  });
});

describe('lectura del remitente de la plataforma', () => {
  it('separa nombre y direccion', () => {
    expect(nombreDeRemitente(PLATAFORMA)).toBe('SentryCore');
    expect(direccionDeRemitente(PLATAFORMA)).toBe('no-reply@sentrycore.cl');
  });

  it('sin nombre usa la parte local del buzon', () => {
    expect(nombreDeRemitente('no-reply@localhost')).toBe('no-reply');
    expect(direccionDeRemitente('no-reply@localhost')).toBe('no-reply@localhost');
  });

  it('tolera el nombre entre comillas', () => {
    expect(nombreDeRemitente('"SentryCore" <no-reply@localhost>')).toBe('SentryCore');
  });
});
