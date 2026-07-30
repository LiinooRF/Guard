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

  // El proveedor de correo aun no esta decidido (issue #9). El codigo va contra
  // una interfaz, asi que cambiar de proveedor es cambiar esta variable.
  MAIL_DRIVER: z.enum(['mailpit', 'smtp', 'brevo']).default('mailpit'),
  MAIL_FROM: z.string().default('VoxIA Control <no-reply@localhost>'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  BREVO_API_KEY: z.string().optional(),

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
  if (env.MAIL_DRIVER === 'brevo' && !env.BREVO_API_KEY) {
    throw new Error('MAIL_DRIVER=brevo requiere BREVO_API_KEY');
  }
  if (env.MAIL_DRIVER === 'smtp' && !env.SMTP_HOST) {
    throw new Error('MAIL_DRIVER=smtp requiere SMTP_HOST');
  }

  return env;
}
