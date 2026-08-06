import { validateEnv } from './env';

const valid = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgresql://app:unique-password@postgres:5432/voxia',
  REDIS_URL: 'redis://:another-unique-password@redis:6379',
  JWT_SECRET: 'a-secure-and-unique-production-secret-with-48-characters',
  MAIL_DRIVER: 'smtp',
  MAIL_FROM: 'VoxIA <no-reply@example.test>',
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: '465',
  SMTP_SECURE: 'true',
  WEB_PUBLIC_URL: 'https://control.example.test',
};

describe('validateEnv', () => {
  it('acepta un entorno de producción completo y seguro', () => {
    expect(validateEnv(valid)).toMatchObject({ NODE_ENV: 'production', SMTP_SECURE: true });
  });

  it.each([
    ['DATABASE_URL', undefined],
    ['REDIS_URL', undefined],
    ['JWT_SECRET', undefined],
  ])('falla rápido si falta %s', (key, value) => {
    expect(() => validateEnv({ ...valid, [key]: value })).toThrow(
      'Configuracion de entorno invalida',
    );
  });

  it('rechaza secretos de ejemplo en staging y producción', () => {
    expect(() => validateEnv({ ...valid, JWT_SECRET: 'cambiar_por_un_secreto_largo_ahora' })).toThrow(
      'no permite credenciales de ejemplo',
    );
  });

  it('rechaza correo local o sin cifrar en producción', () => {
    expect(() => validateEnv({ ...valid, MAIL_DRIVER: 'mailpit' })).toThrow(
      'MAIL_DRIVER debe ser smtp',
    );
    expect(() => validateEnv({ ...valid, SMTP_SECURE: 'false' })).toThrow(
      'SMTP_SECURE=true',
    );
  });

  describe('dominios que no se despachan (#86)', () => {
    it('no deja abrir la escotilla de dominios reservados con un relay real', () => {
      // La escotilla es para Mailpit, que captura todo. Con SMTP detras, abrirla
      // es autorizarse a escribirle a dominios que rebotan siempre (.test de las
      // cuentas demo), y el rebote duro es lo que le cuesta la cuenta de correo a
      // TODA la plataforma. Tiene que doler al arrancar, no cuando dejan de
      // llegar los correos de los clientes que pagan.
      expect(() =>
        validateEnv({ ...valid, MAIL_ALLOW_RESERVED_DOMAINS: 'true' }),
      ).toThrow('MAIL_ALLOW_RESERVED_DOMAINS solo se permite con MAIL_DRIVER=mailpit');
    });

    it('con Mailpit la escotilla se puede abrir', () => {
      expect(
        validateEnv({
          ...valid,
          NODE_ENV: 'development',
          MAIL_DRIVER: 'mailpit',
          MAIL_ALLOW_RESERVED_DOMAINS: 'true',
        }),
      ).toMatchObject({ MAIL_ALLOW_RESERVED_DOMAINS: true });
    });

    it('un valor ambiguo no arranca en vez de quedar en silencio', () => {
      // Antes se leia suelto de process.env y cualquier cosa distinta de 'true'
      // se tomaba como false sin avisar. Un '1' escrito por alguien que creia
      // estar abriendo la escotilla ahora se ve al arrancar.
      expect(() => validateEnv({ ...valid, MAIL_ALLOW_RESERVED_DOMAINS: '1' })).toThrow(
        'Configuracion de entorno invalida',
      );
    });

    it('el default protege sin configurar nada', () => {
      expect(validateEnv(valid)).toMatchObject({
        MAIL_BLOCKED_DOMAINS: '',
        MAIL_ALLOW_RESERVED_DOMAINS: false,
      });
    });
  });
});
