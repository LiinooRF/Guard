import { StructuredLogger } from './structured-logger';

/**
 * El log de un error tiene que servir para diagnosticar SIN contar datos de
 * personas. Las dos mitades importan igual:
 *
 * - Si falta el SQLSTATE, un 500 en produccion se convierte en una caceria a
 *   ciegas. Ya paso: `QueryFailedError` a secas, sin decir que era un `42P08`.
 * - Si sobra el mensaje de PostgreSQL, el log publica la fila que choco. El
 *   texto de un `23505` trae el valor duplicado: correo, nombre o RUT.
 */
describe('StructuredLogger · errores', () => {
  function capturar(fn: (logger: StructuredLogger) => void): string {
    const escrito: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (t: string) => boolean }).write = (texto: string) => {
      escrito.push(texto);
      return true;
    };
    try {
      fn(new StructuredLogger());
    } finally {
      (process.stderr as unknown as { write: typeof original }).write = original;
    }
    return escrito.join('');
  }

  function errorDeConsulta(extra: Record<string, unknown>): Error {
    const error = new Error('mensaje crudo del driver');
    error.name = 'QueryFailedError';
    return Object.assign(error, extra);
  }

  it('registra el SQLSTATE, que es lo que identifica la falla', () => {
    const salida = capturar((logger) =>
      logger.error(errorDeConsulta({ driverError: { code: '42P08' } })),
    );
    expect(JSON.parse(salida).message).toBe('QueryFailedError code=42P08');
  });

  it('registra la restriccion, la tabla y la columna: son nombres del esquema', () => {
    const salida = capturar((logger) =>
      logger.error(
        errorDeConsulta({
          driverError: {
            code: '23505',
            constraint: 'users_active_nfc_card_uid_uniq',
            table: 'users',
            column: 'nfc_card_uid',
          },
        }),
      ),
    );
    const mensaje = JSON.parse(salida).message as string;
    expect(mensaje).toContain('constraint=users_active_nfc_card_uid_uniq');
    expect(mensaje).toContain('table=users');
    expect(mensaje).toContain('column=nfc_card_uid');
  });

  it('NO publica el mensaje del driver: ahi viaja el dato que choco', () => {
    const salida = capturar((logger) =>
      logger.error(
        errorDeConsulta({
          message: 'duplicate key value violates unique constraint; Key (email)=(guardia@empresa.cl) already exists',
          driverError: { code: '23505', detail: 'Key (email)=(guardia@empresa.cl) already exists' },
        }),
      ),
    );
    expect(salida).not.toContain('guardia@empresa.cl');
    expect(salida).not.toContain('duplicate key value');
  });

  it('un error sin datos de PostgreSQL sigue registrando su nombre', () => {
    const salida = capturar((logger) => logger.error(new TypeError('lo que sea')));
    expect(JSON.parse(salida).message).toBe('TypeError');
  });
});
