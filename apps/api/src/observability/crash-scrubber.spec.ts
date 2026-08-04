import {
  LARGO_MAX_LINEA_PILA,
  LARGO_MAX_MENSAJE,
  MAX_LINEAS_PILA,
  auditarTexto,
  depurarEtiqueta,
  depurarPila,
  depurarRuta,
  depurarTexto,
} from './crash-scrubber';

/**
 * Este archivo es la prueba de "ningun evento contiene datos personales del
 * guardia" (#27). Cada caso es un dato que SI aparece en un mensaje de error
 * real: el correo con que se invito al usuario, el token de la sesion, la
 * ubicacion que venia en el cuerpo de la peticion que fallo.
 */
describe('depurarTexto', () => {
  it('tapa un JWT completo', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.QWxndW5hRmlybWFMYXJnYQ';
    const salida = depurarTexto(`fallo al refrescar ${jwt}`);

    expect(salida).not.toContain(jwt);
    expect(salida).toContain('[jwt]');
  });

  it('tapa una credencial de cabecera', () => {
    const salida = depurarTexto('request con Bearer aBcD1234EfGh5678 rechazado');

    expect(salida).not.toContain('aBcD1234EfGh5678');
    expect(salida).toContain('[oculto]');
  });

  it.each([
    ['password=Correcta123', 'Correcta123'],
    ['token: aBcD1234EfGh5678', 'aBcD1234EfGh5678'],
    ['cookie=voxia_sid=abc123def456', 'abc123def456'],
    ['api_key: "clave-secreta-larga"', 'clave-secreta-larga'],
  ])('tapa el valor de %s', (entrada, secreto) => {
    const salida = depurarTexto(entrada);

    expect(salida).not.toContain(secreto);
    expect(salida).toContain('[oculto]');
  });

  it('tapa el correo, que es dato personal aunque parezca tecnico', () => {
    const salida = depurarTexto('no existe usuario jperez@empresa.cl en el tenant');

    expect(salida).not.toContain('jperez@empresa.cl');
    expect(salida).toBe('no existe usuario [correo] en el tenant');
  });

  it('tapa el RUT', () => {
    expect(depurarTexto('rut 12.345.678-9 duplicado')).toBe('rut [rut] duplicado');
    expect(depurarTexto('rut 9876543-K duplicado')).toBe('rut [rut] duplicado');
  });

  it('tapa el telefono chileno con y sin prefijo', () => {
    expect(depurarTexto('no contesta +56912345678')).toBe('no contesta [telefono]');
    expect(depurarTexto('no contesta 9 1234 5678')).toBe('no contesta [telefono]');
  });

  it('tapa la ubicacion, que es lo mas sensible que puede aparecer', () => {
    const salida = depurarTexto('scan fuera de radio en -33.44890,-70.66930');

    expect(salida).not.toContain('-33.44890');
    expect(salida).toContain('[coordenadas]');
  });

  it('tapa la latitud y la longitud sueltas', () => {
    const salida = depurarTexto('{ lat: -33.448901, lng: -70.669265, accuracy: 12 }');

    expect(salida).not.toContain('-33.448901');
    expect(salida).not.toContain('-70.669265');
    expect(salida).toContain('[coordenada]');
  });

  it('tapa la IP y los hashes largos', () => {
    expect(depurarTexto('desde 192.168.10.44')).toBe('desde [ip]');
    expect(depurarTexto(`sesion ${'a1b2c3d4'.repeat(4)}`)).toBe('sesion [hash]');
  });

  it('tapa el nombre de usuario del sistema en las rutas', () => {
    expect(depurarTexto('at /home/jperez/app/index.js:3:1')).toContain('/home/[usuario]');
    expect(depurarTexto('at /home/jperez/app/index.js:3:1')).not.toContain('jperez');
    expect(depurarTexto('C:\\Users\\jperez\\voxia')).not.toContain('jperez');
  });

  it('saca los caracteres de control: rompen el log de una linea por evento', () => {
    expect(depurarTexto('mensaje\u0000con\u001bcontrol')).toBe('mensaje con control');
  });

  it('acota el largo, avisa que corto, y la marca va DENTRO del tope', () => {
    const salida = depurarTexto('x'.repeat(50), 10);

    // Diez caracteres es el TOPE, no lo que se conserva: '[...]' se descuenta.
    expect(salida).toBe(`${'x'.repeat(5)}[...]`);
    expect(salida).toHaveLength(10);
  });

  it('con el tope por defecto nunca pasa el CHECK de la columna', () => {
    // 2000 es `length(error_message) BETWEEN 1 AND 2000` en la migracion. Si
    // depurarTexto devuelve 2005, el INSERT completo se cae con un 500 y la
    // caida que se queria registrar se pierde.
    //
    // OJO con el relleno: 'a'.repeat(3000) NO sirve para esto. Son 3000 nibbles
    // hexadecimales, el patron `hexadecimal_largo` se los come antes de llegar
    // al corte y la salida mide 6 ('[hash]'): el test pasaria sin probar nada.
    const largo = depurarTexto('no se pudo leer la etiqueta '.repeat(200));

    expect(largo.length).toBeLessThanOrEqual(LARGO_MAX_MENSAJE);
    expect(largo.endsWith('[...]')).toBe(true);
  });

  it('un tope mas corto que la propia marca corta a secas y no devuelve de mas', () => {
    expect(depurarTexto('xxxxxxxxxx', 3)).toHaveLength(3);
  });

  it('sobre algo que no es texto devuelve vacio en vez de reventar', () => {
    expect(depurarTexto(undefined)).toBe('');
    expect(depurarTexto({ password: 'secreta' })).toBe('');
    expect(depurarTexto(12345)).toBe('');
  });

  it('depurar dos veces no cambia el resultado', () => {
    const una = depurarTexto('correo jperez@empresa.cl y token: abcd1234efgh');

    expect(depurarTexto(una)).toBe(una);
  });
});

describe('depurarEtiqueta', () => {
  it('no aplica los patrones de texto libre: una version no es una IP', () => {
    expect(depurarEtiqueta('1.2.3.4')).toBe('1.2.3.4');
  });

  it('saca comillas y control, que romperian el JSON del envelope', () => {
    expect(depurarEtiqueta('Redmi "9A"\u0000')).toBe('Redmi  9A');
  });
});

describe('depurarPila', () => {
  it('acota la cantidad de lineas', () => {
    const pila = Array.from({ length: 100 }, (_, i) => `at fn${i} (a.js:${i}:1)`).join('\n');

    expect(depurarPila(pila)).toHaveLength(MAX_LINEAS_PILA);
  });

  it('depura cada linea y descarta las vacias', () => {
    const pila = ['Error: fallo de jperez@empresa.cl', '', '   at /home/jperez/a.js:1:1'].join(
      '\n',
    );
    const salida = depurarPila(pila);

    expect(salida).toHaveLength(2);
    expect(salida.join('\n')).not.toContain('jperez');
  });

  it('sin pila devuelve arreglo vacio', () => {
    expect(depurarPila(undefined)).toEqual([]);
  });

  it('ninguna linea pasa su tope: es lo que hace predecible el largo del texto unido', () => {
    // Un bundle de React Native minificado es exactamente esto: pocas lineas,
    // enormes. Con el corte sumando '[...]' encima, cada linea media 505 y el
    // join daba 20.239 contra un CHECK de 20.000.
    const pila = Array.from({ length: 60 }, (_, i) => `at fn${i} ${'z'.repeat(1_000)}`).join('\n');
    const salida = depurarPila(pila);

    expect(salida).toHaveLength(MAX_LINEAS_PILA);
    for (const linea of salida) {
      expect(linea.length).toBeLessThanOrEqual(LARGO_MAX_LINEA_PILA);
    }
  });
});

describe('depurarRuta', () => {
  it('descarta el query string completo', () => {
    expect(depurarRuta('/api/reports?email=jperez@empresa.cl&token=abc')).toBe('/api/reports');
  });

  it('enmascara el token de traspaso y el de dispositivo', () => {
    expect(depurarRuta(`/api/auth/handoff/${'a'.repeat(43)}`)).toBe('/api/auth/handoff/:token');
    expect(depurarRuta(`/push/devices/${'b'.repeat(60)}`)).toBe('/push/devices/:token');
  });

  it('enmascara los uuid: un id de ronda no agrega nada al agrupar', () => {
    expect(depurarRuta('/api/patrols/3f0d8a1c-1111-4222-8333-444455556666/scan')).toBe(
      '/api/patrols/:id/scan',
    );
  });
});

describe('auditarTexto', () => {
  it('un texto limpio no reporta nada', () => {
    expect(auditarTexto('no se pudo abrir la ronda del turno de noche')).toEqual([]);
  });

  it('reporta cada tipo encontrado, y sigue reportando el segundo', () => {
    const hallazgos = auditarTexto('jperez@empresa.cl desde 10.0.0.1');

    // Si el patron global no se clonara, `.test()` del segundo empezaria donde
    // quedo el primero y devolveria un falso negativo.
    expect(hallazgos).toContain('correo');
    expect(hallazgos).toContain('ip');
  });

  it('lo que sale de depurarTexto ya no tiene nada que reportar', () => {
    const sucio =
      'guardia jperez@empresa.cl rut 12.345.678-9 tel +56912345678 en -33.44890,-70.66930 ' +
      'con token: aBcD1234EfGh5678 desde 192.168.0.5';

    expect(auditarTexto(depurarTexto(sucio))).toEqual([]);
  });
});
