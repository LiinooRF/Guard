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
});
