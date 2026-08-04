import { Inject, Injectable, Logger } from '@nestjs/common';
import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import Redis from 'ioredis';

import {
  CORRELACION_PREFIJO,
  CORRELACION_TTL_SEGUNDOS,
  REGISTRO_CORRELACION_REDIS,
} from './registro-envios.constants';

/**
 * Indice Message-ID -> (tenant, fila del registro) para el webhook del
 * proveedor (#44).
 *
 * EL PROBLEMA QUE RESUELVE, Y POR QUE NO SE RESUELVE EN POSTGRES
 * El webhook del proveedor llega sin sesion y sin tenant: trae un Message-ID y
 * poco mas. Para escribir el estado hay que saber a que empresa pertenece ese
 * mensaje, y esa busqueda es por definicion CRUZADA entre tenants.
 *
 * En esta base eso no se puede hacer con SQL, y no por falta de ganas:
 * mail_deliveries lleva `ENABLE` + `FORCE ROW LEVEL SECURITY`, asi que la
 * politica aplica tambien al dueño de la tabla. Una funcion `SECURITY DEFINER`
 * NO se saltaria nada —con FORCE el dueño obedece sus propias politicas— y la
 * unica forma de leer sin contexto seria abrir la politica con una variable de
 * sesion o usar un rol con BYPASSRLS. Las dos cosas son exactamente el agujero
 * que el producto prohibe (ver CLAUDE.md, regla 1).
 *
 * Por eso el indice vive en Redis, que ya es donde viven las sesiones y los
 * refresh tokens —datos igual de cruzados entre tenants— y no toca RLS.
 *
 * QUE SE PIERDE SI SE LIMPIA REDIS
 * Solo la posibilidad de enriquecer con el estado de entrega los correos que
 * seguian en vuelo. La fila del registro ya quedo en 'enviado' y sigue
 * respondiendo "se envio y a quien", que es el criterio de aceptacion del issue.
 * Ese es justamente el reparto: lo que tiene que sobrevivir a Redis esta en
 * Postgres, y lo efimero esta en Redis.
 *
 * LA LLAVE VA HASHEADA. Un Message-ID lleva el dominio de envio y, con algunos
 * proveedores, parte del sobre. Hasheado, el indice no es legible para quien
 * mire las llaves de Redis, y ademas queda de largo fijo. Mismo criterio que la
 * clave de idempotencia de la cola de correo.
 */

/**
 * Lo minimo que se le pide al cliente Redis. Acotarlo asi deja el servicio
 * testeable con un objeto plano y sin levantar Redis.
 */
export interface ClienteCorrelacion {
  set(clave: string, valor: string, modo: 'EX', segundos: number): Promise<unknown>;
  get(clave: string): Promise<string | null>;
}

export interface Correlacion {
  readonly tenantId: string;
  readonly registroId: string;
}

export const registroCorrelacionRedisProvider: FactoryProvider<Redis> = {
  provide: REGISTRO_CORRELACION_REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new Redis(config.getOrThrow<string>('REDIS_URL'), {
      enableOfflineQueue: false,
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    }),
};

@Injectable()
export class RegistroCorrelacionService {
  private readonly logger = new Logger(RegistroCorrelacionService.name);

  constructor(
    @Inject(REGISTRO_CORRELACION_REDIS)
    private readonly redis: ClienteCorrelacion,
  ) {}

  /**
   * Deja anotado a quien pertenece un Message-ID recien enviado.
   *
   * Nunca lanza: si Redis no esta, el correo ya salio y la fila ya quedo
   * registrada. Perder la correlacion degrada el estado de entrega, no el envio.
   */
  async recordar(messageId: string, correlacion: Correlacion): Promise<boolean> {
    const clave = claveDe(messageId);
    if (!clave) return false;

    try {
      await this.redis.set(
        clave,
        `${correlacion.tenantId}:${correlacion.registroId}`,
        'EX',
        CORRELACION_TTL_SEGUNDOS,
      );
      return true;
    } catch (error) {
      // Sin el Message-ID ni el correo: solo que la correlacion no se pudo
      // guardar y de que empresa era.
      this.logger.warn(
        JSON.stringify({
          event: 'correlacion_no_guardada',
          tenant_id: correlacion.tenantId,
          error: nombreDeError(error),
        }),
      );
      return false;
    }
  }

  /** A quien pertenece este Message-ID, o null si ya no se sabe. */
  async resolver(messageId: string): Promise<Correlacion | null> {
    const clave = claveDe(messageId);
    if (!clave) return null;

    let crudo: string | null;
    try {
      crudo = await this.redis.get(clave);
    } catch (error) {
      this.logger.warn(
        JSON.stringify({ event: 'correlacion_no_leida', error: nombreDeError(error) }),
      );
      return null;
    }
    if (!crudo) return null;

    // El valor lo escribimos nosotros, pero se valida igual: una llave pisada a
    // mano no puede terminar en un UPDATE contra un tenant cualquiera.
    const separador = crudo.indexOf(':');
    if (separador <= 0) return null;
    const tenantId = crudo.slice(0, separador);
    const registroId = crudo.slice(separador + 1);
    if (!esUuid(tenantId) || !esUuid(registroId)) return null;

    return { tenantId, registroId };
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function esUuid(valor: string): boolean {
  return UUID.test(valor);
}

/**
 * El Message-ID viaja entre angulos ("<abc@host>") en unos proveedores y pelado
 * en otros. Se normaliza antes de hashear para que las dos formas caigan en la
 * misma llave.
 */
export function normalizarMessageId(messageId: string): string {
  return messageId.trim().replace(/^<|>$/g, '').toLowerCase();
}

function claveDe(messageId: string): string | null {
  const normalizado = normalizarMessageId(messageId);
  if (normalizado.length === 0) return null;
  return `${CORRELACION_PREFIJO}${createHash('sha256').update(normalizado).digest('hex')}`;
}

function nombreDeError(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}
