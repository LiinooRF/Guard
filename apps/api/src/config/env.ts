import { z } from 'zod';

/**
 * Validacion del entorno.
 *
 * Si falta una variable, el proceso NO levanta y dice exactamente cual. Es
 * deliberado: una API que arranca a medias y falla en produccion tres horas
 * despues es mucho peor que una que se niega a arrancar con un mensaje claro.
 *
 * Ver issue #6, sub-issue de gestion de secretos.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  API_PORT: z.coerce.number().int().positive().default(3001),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  // El proveedor de correo aun NO esta decidido (issue #9). El codigo va contra
  // la interfaz MailProvider, asi que elegir despues no cuesta nada.
  //
  //   mailpit  desarrollo: captura todo, nada sale a internet
  //   smtp     cualquier servidor SMTP: Postal o Mailu self-hosted, un relay
  //            externo, SES... solo cambian las SMTP_*
  //
  // El driver `smtp` generico cubre cualquier proveedor. No agregamos un
  // adaptador por marca hasta que se decida y haya una razon concreta para
  // usar su API en vez de SMTP.
  MAIL_DRIVER: z.enum(['mailpit', 'smtp']).default('mailpit'),
  MAIL_FROM: z.string().default('VoxIA Control <no-reply@localhost>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  WEB_PUBLIC_URL: z.string().url().default('http://localhost:3000'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);

  if (!parsed.success) {
    const detalle = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(
      `\nConfiguracion de entorno invalida:\n${detalle}\n\n` +
        `Copia .env.example a .env y completa los valores que faltan.\n`,
    );
  }

  const env = parsed.data;

  // Coherencia entre el driver de correo y sus credenciales: si no se valida
  // aca, el error aparece recien cuando alguien no recibe su invitacion.
  if (env.MAIL_DRIVER === 'smtp' && !env.SMTP_HOST) {
    throw new Error('MAIL_DRIVER=smtp requiere SMTP_HOST');
  }

  // En produccion no se envia correo real por un canal sin cifrar.
  if (env.NODE_ENV === 'production' && env.MAIL_DRIVER === 'smtp' && !env.SMTP_SECURE) {
    throw new Error('en produccion MAIL_DRIVER=smtp requiere SMTP_SECURE=true');
  }

  return env;
}
