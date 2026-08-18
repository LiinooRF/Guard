import 'reflect-metadata';

import { MailpitProvider } from './mailpit.provider';
import { DOMINIOS_NO_DESPACHABLES, esDespachable } from './mail-dominios';
import {
  MailModule,
  createDominiosNoDespachables,
  createMailProvider,
  redisOptionsFromUrl,
} from './mail.module';
import { MailQueueService } from './mail-queue.service';
import { SmtpProvider } from './smtp.provider';

const baseEnvironment = {
  MAIL_FROM: 'SentryCore <no-reply@example.test>',
  MAILPIT_HOST: 'localhost',
  MAILPIT_PORT: 1025,
  SMTP_HOST: 'smtp.example.test',
  SMTP_PORT: 587,
  SMTP_USER: 'user',
  SMTP_PASSWORD: 'secret',
  SMTP_SECURE: true,
} as const;

describe('createMailProvider', () => {
  it('selecciona Mailpit mediante MAIL_DRIVER', () => {
    expect(
      createMailProvider({ ...baseEnvironment, MAIL_DRIVER: 'mailpit' }),
    ).toBeInstanceOf(MailpitProvider);
  });

  it('selecciona SMTP mediante MAIL_DRIVER', () => {
    expect(
      createMailProvider({ ...baseEnvironment, MAIL_DRIVER: 'smtp' }),
    ).toBeInstanceOf(SmtpProvider);
  });
});

/**
 * La factory que le entrega la lista a MailQueueService (#86).
 *
 * Prueba la traduccion entre el esquema zod —que ya convirtio la escotilla a
 * booleano— y la funcion pura, que trabaja con el literal 'true'. Es un paso de
 * ida y vuelta chico y es exactamente donde se pierde una proteccion sin que
 * ningun test lo note.
 */
describe('createDominiosNoDespachables', () => {
  it('con el entorno por defecto ya protege a la cuenta demo', () => {
    const lista = createDominiosNoDespachables({
      MAIL_BLOCKED_DOMAINS: '',
      MAIL_ALLOW_RESERVED_DOMAINS: false,
    });

    expect(esDespachable('admin@demo-andina.test', lista)).toBe(false);
    expect(esDespachable('jefa@empresa.cl', lista)).toBe(true);
  });

  it('MAIL_BLOCKED_DOMAINS suma dominios propios', () => {
    const lista = createDominiosNoDespachables({
      MAIL_BLOCKED_DOMAINS: 'demo-andina.cl, staging.sentrycore.cl',
      MAIL_ALLOW_RESERVED_DOMAINS: false,
    });

    expect(esDespachable('a@demo-andina.cl', lista)).toBe(false);
    expect(esDespachable('a@staging.sentrycore.cl', lista)).toBe(false);
    expect(esDespachable('a@demo-andina.test', lista)).toBe(false);
  });

  it('el booleano ya validado llega intacto a la funcion pura', () => {
    // Si esta traduccion se rompiera —devolver 'True', o el booleano crudo— la
    // escotilla quedaria cerrada para siempre y nadie se enteraria hasta que un
    // desarrollador reporte que Mailpit esta vacio.
    const abierta = createDominiosNoDespachables({
      MAIL_BLOCKED_DOMAINS: '',
      MAIL_ALLOW_RESERVED_DOMAINS: true,
    });

    expect(esDespachable('admin@demo-andina.test', abierta)).toBe(true);
  });
});

/**
 * El cableado de Nest, leido de la metadata del modulo.
 *
 * No levanta el contenedor —`MailModule` abre la conexion de BullMQ y eso
 * necesita Redis—, pero cubre el unico error que ningun otro test de este
 * carril veria: que la lista quede escrita, probada y NUNCA registrada como
 * provider. `MailQueueService` la pide por token, asi que ese olvido no lo
 * atrapa el compilador: revienta al arrancar la API, en el despliegue.
 */
describe('MailModule (cableado)', () => {
  const metadata = (clave: string): unknown[] =>
    (Reflect.getMetadata(clave, MailModule) as unknown[] | undefined) ?? [];

  it('registra la lista de dominios no despachables como provider', () => {
    const provee = metadata('providers').some(
      (p) => typeof p === 'object' && p !== null && 'provide' in p
        && (p as { provide: unknown }).provide === DOMINIOS_NO_DESPACHABLES,
    );
    expect(provee).toBe(true);
  });

  it('exporta la lista y la cola juntas', () => {
    // Quien tenga que decidir antes de encolar (el despacho del informe, que
    // escribe en `report_deliveries` primero) necesita la MISMA lista que usa
    // la cola. Dos listas resueltas por separado son dos verdades.
    expect(metadata('exports')).toEqual(expect.arrayContaining([DOMINIOS_NO_DESPACHABLES]));
    expect(metadata('exports')).toEqual(expect.arrayContaining([MailQueueService]));
  });
});

describe('redisOptionsFromUrl', () => {
  it('preserva autenticacion, base y TLS para BullMQ', () => {
    expect(redisOptionsFromUrl('rediss://queue-user:secret@redis.example.test:6380/4')).toEqual({
      host: 'redis.example.test',
      port: 6380,
      username: 'queue-user',
      password: 'secret',
      db: 4,
      tls: {},
    });
  });
});
