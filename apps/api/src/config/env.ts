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
  SCAN_SYNC_QUEUE_NAME: z.string().min(1).default('scan-sync'),
  SCAN_SYNC_LAG_ALERT_SECONDS: z.coerce.number().int().positive().default(300),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),

  // Evidencia fotografica (#13): raiz donde se guardan las fotos de escaneo,
  // organizadas como EVIDENCE_PATH/<tenant>/<ronda>/. En Dokploy debe ser un
  // volumen persistente; sin el, un redeploy pierde la evidencia.
  EVIDENCE_PATH: z.string().min(1).default('./storage/evidence'),

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
  MAIL_FROM: z.string().default('SentryCore <no-reply@localhost>'),
  MAILPIT_HOST: z.string().default('localhost'),
  MAILPIT_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_SECURE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Dominios a los que el producto NO le escribe (#86, mail/mail-dominios.ts).
  //
  // No es una regla de negocio y por eso no va a rules.ts: es una proteccion de
  // la reputacion de envio de la PLATAFORMA, compartida por todos los tenants.
  // Los reservados por norma (RFC 2606/6761/6762) ya vienen bloqueados de
  // fabrica —ahi caen las cuentas demo @demo-andina.test—; esta lista SUMA
  // dominios propios y no reemplaza nada.
  MAIL_BLOCKED_DOMAINS: z.string().default(''),
  // Escotilla de escape para desarrollo con Mailpit, que captura todo y no manda
  // nada a internet. Se declara aca —y no se lee suelta de process.env— para que
  // abrirla sea visible al arrancar: un valor ambiguo ('1', 'si', 'TRUE') hace
  // fallar el arranque en vez de quedar en silencio, igual que SMTP_SECURE.
  //
  // Lo que decide NO es si hay supresion, sino si los dominios RESERVADOS POR
  // NORMA entran a la lista. Con la escotilla abierta, MAIL_BLOCKED_DOMAINS
  // sigue bloqueando igual.
  MAIL_ALLOW_RESERVED_DOMAINS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  // Webhook de estado de entrega del correo (#220). Mismo criterio que
  // MAIL_DRIVER: el codigo va contra la interfaz TraductorWebhookCorreo y el
  // proveedor NO esta decidido (#9).
  //
  //   interno  el contrato de ingesta que definimos nosotros, firmado con HMAC
  //            y alimentado por un relay de una pagina desde el webhook del
  //            proveedor que sea. Es el unico que se puede escribir sin
  //            inventarse el formato de nadie.
  //
  // Se agrega un valor por proveedor recien cuando #9 se cierre; el `switch` de
  // crearTraductorWebhook es exhaustivo, asi que agregarlo y olvidar el
  // traductor no compila.
  NOTIF_WEBHOOK_DRIVER: z.enum(['interno']).default('interno'),
  // SECRETO: va en el gestor de secretos de Dokploy, nunca en el repositorio.
  // Se comparte con el relay, que firma con el mismo HMAC.
  //
  // NO se exige, ni siquiera en produccion, y no es un olvido: sin el, el
  // endpoint publico falla CERRADO con 503 en cada peticion (ver
  // registro-envios.firma.ts). Un canal de notificaciones sin configurar no
  // puede impedir que la API arranque — mismo criterio que PUSH_DRIVER.
  //
  // El minimo de largo si se exige cuando esta: un secreto compartido corto
  // convierte el HMAC en un adorno, y es mejor descubrirlo al arrancar que
  // cuando alguien escriba el estado de entrega de una empresa ajena.
  //
  // VACIO Y AUSENTE SON LO MISMO: canal apagado. `.env.example` la trae vacia y
  // un `.min(32)` a secas dejaria sin arrancar a cualquiera que copie el
  // ejemplo, que es como se levanta el entorno de desarrollo.
  NOTIF_WEBHOOK_SECRET: z
    .union([
      z.literal(''),
      z.string().min(32, 'NOTIF_WEBHOOK_SECRET debe tener al menos 32 caracteres'),
    ])
    .optional()
    .transform((valor) => (valor ? valor : undefined)),

  // Notificaciones push (#113). Mismo criterio que el correo: el codigo va
  // contra la interfaz PushProvider y el proveedor NO esta decidido.
  //
  //   log  desarrollo y default: escribe el aviso en el log y no manda nada
  //   fcm  Firebase Cloud Messaging. Declarado y documentado en
  //        push/fcm.provider.ts, todavia SIN adaptador: seleccionarlo hoy hace
  //        fallar el arranque a proposito, en vez de descubrirlo en el primer
  //        panico que no suena.
  //
  // No se exige `fcm` en produccion, a diferencia de MAIL_DRIVER=smtp: el push
  // es un canal ADICIONAL. El correo sigue siendo el aviso garantizado, y
  // bloquear el despliegue por un proveedor no decidido seria cambiar una
  // notificacion que no suena por un producto que no arranca.
  PUSH_DRIVER: z.enum(['log', 'fcm']).default('log'),
  FCM_PROJECT_ID: z.string().optional(),
  FCM_CLIENT_EMAIL: z.string().optional(),
  // SECRETO: va en el gestor de secretos de Dokploy, nunca en el repositorio.
  // Se guarda con los saltos de linea escapados (`\n`); el adaptador los
  // desescapa antes de firmar.
  FCM_PRIVATE_KEY: z.string().optional(),

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

  if (env.NODE_ENV === 'production' && env.MAIL_DRIVER !== 'smtp') {
    throw new Error('en produccion MAIL_DRIVER debe ser smtp');
  }

  // En produccion no se envia correo real por un canal sin cifrar.
  if (env.NODE_ENV === 'production' && env.MAIL_DRIVER === 'smtp' && !env.SMTP_SECURE) {
    throw new Error('en produccion MAIL_DRIVER=smtp requiere SMTP_SECURE=true');
  }

  // La escotilla de dominios reservados es para Mailpit, que captura todo y no
  // manda nada a internet. Con un relay real detras, abrirla es autorizarse a
  // escribirle a dominios que rebotan SIEMPRE (.test, .invalid, .example), y los
  // rebotes duros son la metrica con la que un proveedor suspende la cuenta de
  // correo de toda la plataforma. Se falla al arrancar, no cuando dejan de
  // llegar los correos de los clientes que pagan.
  if (env.MAIL_ALLOW_RESERVED_DOMAINS && env.MAIL_DRIVER === 'smtp') {
    throw new Error('MAIL_ALLOW_RESERVED_DOMAINS solo se permite con MAIL_DRIVER=mailpit');
  }

  // Mismo criterio que el correo: las credenciales del push se validan al
  // arrancar y no cuando falla el primer aviso.
  if (
    env.PUSH_DRIVER === 'fcm' &&
    (!env.FCM_PROJECT_ID || !env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY)
  ) {
    throw new Error('PUSH_DRIVER=fcm requiere FCM_PROJECT_ID, FCM_CLIENT_EMAIL y FCM_PRIVATE_KEY');
  }

  if (
    ['staging', 'production'].includes(env.NODE_ENV) &&
    /cambiar|change-?me|example|demo/i.test(env.JWT_SECRET)
  ) {
    throw new Error(`${env.NODE_ENV} no permite credenciales de ejemplo en JWT_SECRET`);
  }

  return env;
}
