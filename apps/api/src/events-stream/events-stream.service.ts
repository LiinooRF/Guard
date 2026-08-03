import { ForbiddenException, Injectable, Logger, type MessageEvent } from '@nestjs/common';
import {
  defer,
  filter,
  finalize,
  interval,
  map,
  merge,
  of,
  Subject,
  takeUntil,
  timer,
  type Observable,
} from 'rxjs';
import { DataSource } from 'typeorm';

import type { Criticality } from '../guard/dto/report-event.dto';

/**
 * Bandeja del supervisor en tiempo real (#128).
 *
 * SERVER-SENT EVENTS, NO WEBSOCKET. La bandeja es un flujo unidireccional
 * servidor -> cliente: el supervisor mira, no escribe por este canal (el acuse
 * de recibo ya es un POST). SSE es HTTP normal, asi que atraviesa el proxy de
 * Dokploy sin configuracion extra, reusa la cookie de sesion que ya viaja en
 * cada request y el navegador reconecta solo. Un WebSocket agregaria un
 * protocolo mas, estado de conexion propio, su propio camino de autenticacion y
 * reglas en Traefik para el Upgrade — todo eso para ganar un canal de subida
 * que aca nadie usa.
 *
 * LIMITACION CONOCIDA — UNA SOLA REPLICA. El emisor vive en la memoria del
 * proceso: un evento publicado en la replica A NO llega a los suscriptores
 * conectados a la replica B. Hoy la API corre con una sola replica (ver
 * docker-compose.dokploy.yml: `api` no declara `deploy.replicas`, y las
 * migraciones corren en el mismo arranque justamente porque se asume un solo
 * proceso), asi que la limitacion no se manifiesta.
 *
 * LA SALIDA, cuando haya mas de una replica: Redis pub/sub. Redis YA esta en el
 * stack (sesiones, rate limiting, BullMQ), asi que no agrega infraestructura:
 * `publish()` pasa a un PUBLISH sobre el canal `bandeja:<tenant>` y cada replica
 * se SUBSCRIBE y alimenta su Subject local. El cambio queda contenido en esta
 * clase: ni el controlador ni los publicadores se enteran. No se implementa hoy
 * porque una suscripcion Redis por proceso, su reconexion y su manejo de errores
 * es codigo que hay que mantener y probar para resolver un problema que todavia
 * no existe.
 */

/** Sin trafico, los proxies cortan la conexion ociosa cerca de los 60s. */
export const HEARTBEAT_MS = 20_000;

/**
 * Cota de vida de una conexion. El guard autoriza AL CONECTAR y no vuelve a
 * correr: sin este tope, una sesion revocada seguiria recibiendo eventos
 * mientras el socket siguiera abierto. Al completarse el flujo el navegador
 * reconecta solo y vuelve a pasar por autenticacion y alcance.
 */
export const STREAM_TTL_MS = 15 * 60_000;

/** Se manda como `retry` en el primer mensaje: el reintento no queda al azar. */
export const RECONNECT_HINT_MS = 5_000;

export interface NovedadStreamEvent {
  type: 'novedad';
  siteId: string;
  eventId: string;
  criticality: Criticality;
  patrolId: string | null;
  reportedAt: string;
}

export interface ChecklistFallaStreamEvent {
  type: 'checklist_falla';
  siteId: string;
  responseId: string;
  patrolId: string;
  itemLabel: string;
  respondedAt: string;
}

/**
 * Aviso, no detalle. El payload lleva identificadores y lo minimo para pintar
 * una fila; el cuerpo del evento y quien lo reporto salen de
 * GET /supervisor/sites/:siteId/events. Asi el reenganche tras una reconexion
 * es una sola consulta y no hace falta un backlog en memoria.
 */
export type StreamEvent = NovedadStreamEvent | ChecklistFallaStreamEvent;

interface Canal {
  subject: Subject<StreamEvent>;
  suscriptores: number;
}

@Injectable()
export class EventsStreamService {
  private readonly logger = new Logger(EventsStreamService.name);

  /** Un canal por empresa. Se crea con el primer suscriptor y se borra con el ultimo. */
  private readonly canales = new Map<string, Canal>();

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Publica un evento a los supervisores conectados de esa empresa. Nunca lanza:
   * el registro del evento en la base ya ocurrio y vale mas que la notificacion.
   *
   * Se emite DENTRO de la transaccion del request, asi que un rollback posterior
   * dejaria un aviso de algo que no quedo escrito. Es aceptable porque el aviso
   * no trae estado: el cliente refresca con GET /supervisor/sites/:siteId/events
   * y no encuentra nada. Al reves —emitir despues del commit— habria que
   * acarrear el evento hasta el interceptor y perder el aviso si el proceso
   * muere en el medio.
   */
  publish(tenantId: string, evento: StreamEvent): void {
    const canal = this.canales.get(tenantId);
    if (!canal) return;

    try {
      canal.subject.next(evento);
    } catch (error) {
      this.logger.warn(
        JSON.stringify({
          event: 'bandeja_emision_fallo',
          tenant_id: tenantId,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  /**
   * El flujo que consume el controlador. Trae tres cosas mezcladas: el saludo
   * inicial (que confirma la conexion y fija el retry del navegador), los
   * eventos del recinto y el latido.
   *
   * LO QUE NO HACE: recuperar lo emitido mientras el cliente estuvo
   * desconectado. No hay backlog ni Last-Event-ID; la reconexion de la bandeja
   * se reconcilia con GET /supervisor/sites/:siteId/events.
   */
  streamForSite(tenantId: string, siteId: string): Observable<MessageEvent> {
    const eventos = defer(() => {
      const canal = this.canalDe(tenantId);
      canal.suscriptores += 1;
      return canal.subject.asObservable();
    }).pipe(
      filter((evento) => evento.siteId === siteId),
      map((evento): MessageEvent => ({ type: evento.type, data: evento })),
      finalize(() => this.soltarCanal(tenantId)),
    );

    const latidos = interval(HEARTBEAT_MS).pipe(
      map((): MessageEvent => ({ type: 'ping', data: { at: new Date().toISOString() } })),
    );

    const saludo: MessageEvent = {
      type: 'ready',
      data: { siteId, heartbeatMs: HEARTBEAT_MS, ttlMs: STREAM_TTL_MS },
      retry: RECONNECT_HINT_MS,
    };

    return merge(of(saludo), eventos, latidos).pipe(takeUntil(timer(STREAM_TTL_MS)));
  }

  /**
   * El SUPERVISOR esta limitado a SUS recintos asignados. Se verifica con la
   * misma consulta que SupervisorService.ensureAssignedSite, pero abriendo una
   * transaccion propia y corta: este endpoint corre con @SkipTenantContext()
   * (ver el controlador) y no tiene el manager del interceptor.
   */
  async ensureAssignedSite(tenantId: string, supervisorId: string, siteId: string): Promise<void> {
    const filas = await this.consultaConTenant<{ present: boolean }>(
      tenantId,
      supervisorId,
      `SELECT true AS present FROM supervisor_sites
       WHERE site_id = $1 AND supervisor_id = $2`,
      [siteId, supervisorId],
    );
    if (!filas.length) {
      throw new ForbiddenException('No tienes este recinto asignado');
    }
  }

  /** Canales vivos. Lo usa el test de fuga y sirve como metrica si hace falta. */
  activeChannels(): number {
    return this.canales.size;
  }

  /**
   * Transaccion propia con contexto de tenant. `set_config(..., true)` es
   * SET LOCAL: la variable muere con la transaccion y no se pega a la conexion
   * del pool. Se abre, se consulta y se cierra ANTES de que empiece el streaming;
   * una conexion de PostgreSQL no puede quedar tomada mientras dura el SSE.
   */
  private async consultaConTenant<T>(
    tenantId: string,
    userId: string,
    sql: string,
    parametros: unknown[],
  ): Promise<T[]> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    try {
      await runner.manager.query(
        `SELECT
          set_config('app.tenant_id', $1, true),
          set_config('app.user_id', $2, true),
          set_config('app.support_access_id', '', true)`,
        [tenantId, userId],
      );
      const filas = await runner.manager.query<T[]>(sql, parametros);
      await runner.commitTransaction();
      return filas;
    } catch (error) {
      await runner.rollbackTransaction();
      throw error;
    } finally {
      await runner.release();
    }
  }

  private canalDe(tenantId: string): Canal {
    const existente = this.canales.get(tenantId);
    if (existente) return existente;

    const canal: Canal = { subject: new Subject<StreamEvent>(), suscriptores: 0 };
    this.canales.set(tenantId, canal);
    return canal;
  }

  private soltarCanal(tenantId: string): void {
    const canal = this.canales.get(tenantId);
    if (!canal) return;

    canal.suscriptores -= 1;
    if (canal.suscriptores > 0) return;

    // Sin el borrado, el Map acumularia una entrada por empresa que alguna vez
    // se conecto y no se liberaria nunca.
    this.canales.delete(tenantId);
    canal.subject.complete();
  }
}
