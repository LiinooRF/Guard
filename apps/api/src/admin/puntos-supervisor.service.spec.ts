import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { hasPermission } from '@voxia/shared';

import type { AuditService } from '../audit/audit.service';
import type { AuthService } from '../auth/auth.service';
import type { MailService } from '../auth/mail.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { SupervisorService } from '../supervisor/supervisor.service';
import { AdminService } from './admin.service';
import { PuntosSupervisorService } from './puntos-supervisor.service';

/**
 * El alcance del SUPERVISOR sobre puntos de control y etiquetas NFC (#309).
 *
 * El rol NO basta: `checkpoints:manage` dice que puede administrar puntos, no en
 * que recintos. Eso lo decide `supervisor_sites`, y estas pruebas son las unicas
 * que miran esa segunda puerta — la matriz de autorizacion solo ve la primera.
 *
 * Se arma con el AdminService REAL sobre un `query` de mentira, no con un
 * AdminService mockeado: asi las pruebas ven el SQL que se manda de verdad,
 * incluido el `EXISTS (SELECT 1 FROM supervisor_sites ...)` pegado a la
 * sentencia de escritura. Un mock del servicio de abajo convertiria justo esa
 * parte en decoracion.
 *
 * COMPROBADO QUE FALLAN SIN EL ARREGLO: quitando la llamada a
 * `ensureAssignedSite` de PuntosSupervisorService, los casos de "recinto ajeno"
 * pasan a escribir y las pruebas se caen; quitando el `EXISTS` de AdminService,
 * se cae el caso TOCTOU.
 */

const RECINTO_PROPIO = 'site-propio';
const RECINTO_AJENO = 'site-ajeno';
const SUPERVISOR = 'sup-1';

/** Lo que devuelve el driver para UPDATE/DELETE: [filas, rowCount], no filas. */
const comoDriver = <T>(filas: T[]): [T[], number] => [filas, filas.length];

function armar(opciones: {
  /** Recintos que este supervisor tiene en `supervisor_sites`. */
  asignados?: string[];
  /** Respuestas por sentencia, elegidas por un fragmento del SQL. */
  respuestas?: Array<[fragmento: string, valor: unknown]>;
} = {}) {
  const asignados = opciones.asignados ?? [RECINTO_PROPIO];
  const respuestas = opciones.respuestas ?? [];

  const query = jest.fn().mockImplementation(async (sql: string) => {
    for (const [fragmento, valor] of respuestas) {
      if (sql.includes(fragmento)) return valor;
    }
    return [];
  });

  // Copia fiel de SupervisorService.ensureAssignedSite: 403 si el recinto no
  // esta en supervisor_sites. Un mock que siempre resuelva convertiria estas
  // pruebas en decoracion.
  const ensureAssignedSite = jest.fn().mockImplementation(async (siteId: string) => {
    if (!asignados.includes(siteId)) {
      throw new ForbiddenException('No tienes este recinto asignado');
    }
  });

  const record = jest.fn().mockResolvedValue(undefined);
  const admin = new AdminService(
    { manager: { query } } as unknown as TenantContextService,
    { revokeAllSessions: jest.fn() } as unknown as AuthService,
    {} as MailService,
    { record } as unknown as AuditService,
  );
  const service = new PuntosSupervisorService(
    admin,
    { ensureAssignedSite } as unknown as SupervisorService,
  );
  return { service, admin, query, ensureAssignedSite, record };
}

/** El punto existe y vive en `siteId`. Es lo que responde `ensureCheckpoint`. */
const puntoEn = (siteId: string) => [
  { id: 'cp-1', name: 'Bodega', site_id: siteId, site_name: 'Planta Sur' },
];

const SQL_PUNTO = 'FROM checkpoints c JOIN sites s';
const SQL_ETIQUETA = 'FROM tags t';
const SQL_ACTOR = 'FROM users WHERE id';

describe('PuntosSupervisorService — el supervisor solo llega a sus recintos (#309)', () => {
  it('crear un punto en un recinto NO asignado es 403 y no escribe nada', async () => {
    const { service, query } = armar();

    await expect(
      service.createCheckpoint(RECINTO_AJENO, SUPERVISOR, { name: 'Bodega' }),
    ).rejects.toThrow(ForbiddenException);
    // Ni el SELECT del recinto llego a correr: se corta antes de mirar nada.
    expect(query).not.toHaveBeenCalled();
  });

  it('con el recinto asignado, el punto se crea', async () => {
    const { service, ensureAssignedSite } = armar({
      respuestas: [['SELECT id, name FROM sites', [{ id: RECINTO_PROPIO, name: 'Planta Sur' }]]],
    });

    const creado = await service.createCheckpoint(RECINTO_PROPIO, SUPERVISOR, { name: 'Bodega' });

    expect(ensureAssignedSite).toHaveBeenCalledWith(RECINTO_PROPIO, SUPERVISOR);
    expect(creado.id).toEqual(expect.any(String));
  });

  it('importar por CSV en un recinto ajeno tampoco pasa', async () => {
    const { service, query } = armar();

    await expect(
      service.importCheckpoints(RECINTO_AJENO, SUPERVISOR, [{ name: 'Bodega' }]),
    ).rejects.toThrow(ForbiddenException);
    expect(query).not.toHaveBeenCalled();
  });

  it('listar los puntos de un recinto ajeno no devuelve ni los nombres', async () => {
    const { service, query } = armar();

    await expect(service.listCheckpoints(RECINTO_AJENO, SUPERVISOR)).rejects.toThrow(
      ForbiddenException,
    );
    expect(query).not.toHaveBeenCalled();
  });

  /**
   * El caso central del issue: el recinto NO viene en la URL, hay que sacarlo
   * del punto. Sin esa resolucion, `checkpoints:manage` seria acceso a todos los
   * puntos del tenant con solo conocer un id.
   */
  it('editar un punto de otro recinto del MISMO tenant es 403, no 404', async () => {
    const { service, query } = armar({
      respuestas: [[SQL_PUNTO, puntoEn(RECINTO_AJENO)]],
    });

    await expect(
      service.updateCheckpoint('cp-1', SUPERVISOR, { name: 'Otro nombre' }),
    ).rejects.toThrow(ForbiddenException);
    // Se resolvio el recinto y se corto ahi: ningun UPDATE.
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('UPDATE checkpoints'))).toBe(
      false,
    );
  });

  it('dar de baja un punto de otro recinto del mismo tenant tampoco pasa', async () => {
    const { service, query } = armar({
      respuestas: [[SQL_PUNTO, puntoEn(RECINTO_AJENO)]],
    });

    await expect(service.setCheckpointActive('cp-1', SUPERVISOR, false)).rejects.toThrow(
      ForbiddenException,
    );
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('UPDATE checkpoints'))).toBe(
      false,
    );
  });

  it('vincular una etiqueta sobre un punto de un recinto ajeno es 403', async () => {
    const { service, query } = armar({
      respuestas: [[SQL_PUNTO, puntoEn(RECINTO_AJENO)]],
    });

    await expect(
      service.registerTag('cp-1', SUPERVISOR, { uid: '04AABBCC' }),
    ).rejects.toThrow(ForbiddenException);
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('INSERT INTO tags'))).toBe(false);
    // Y tampoco alcanzo a desactivar la etiqueta buena del punto ajeno.
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('UPDATE tags'))).toBe(false);
  });

  it('listar las etiquetas de un punto de un recinto ajeno tampoco pasa', async () => {
    const { service, query } = armar({
      respuestas: [[SQL_PUNTO, puntoEn(RECINTO_AJENO)]],
    });

    await expect(service.listTags('cp-1', SUPERVISOR)).rejects.toThrow(ForbiddenException);
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('FROM tags\n'))).toBe(false);
  });

  it('retirar una etiqueta de un punto ajeno es 403: el recinto se resuelve etiqueta -> punto', async () => {
    const { service, query } = armar({
      respuestas: [
        [SQL_ETIQUETA, [{ tag_id: 'tag-1', ...puntoEn(RECINTO_AJENO)[0] }]],
      ],
    });

    await expect(service.retireTag('tag-1', SUPERVISOR)).rejects.toThrow(ForbiddenException);
    expect(query.mock.calls.some(([sql]: [string]) => sql.includes('UPDATE tags'))).toBe(false);
  });

  /**
   * Un punto de otra EMPRESA no lo ve la consulta: RLS lo filtra antes, asi que
   * llegan cero filas. Que eso termine en 404 y no en 403 es parte del contrato
   * — un 403 le confirmaria a quien prueba ids que ese id existe en alguna parte.
   */
  it('un punto de otra empresa es 404: RLS lo filtra y no llega ninguna fila', async () => {
    const { service, ensureAssignedSite } = armar({
      respuestas: [[SQL_PUNTO, []]],
    });

    await expect(service.updateCheckpoint('cp-de-otro-tenant', SUPERVISOR, { name: 'x' })).rejects.toThrow(
      NotFoundException,
    );
    expect(ensureAssignedSite).not.toHaveBeenCalled();
  });

  it('un punto que no existe es 404, con el mismo mensaje que para el ADMIN', async () => {
    const { service } = armar({ respuestas: [[SQL_PUNTO, []]] });

    await expect(service.listTags('cp-inexistente', SUPERVISOR)).rejects.toThrow(
      'Punto de control no encontrado',
    );
  });
});

describe('PuntosSupervisorService — el guardia pegado a la escritura (#309)', () => {
  /**
   * El caso TOCTOU: el pre-chequeo paso —el recinto era suyo cuando se
   * comprobo— y aun asi la sentencia de escritura no toca ninguna fila porque
   * el `EXISTS` sobre supervisor_sites ya no se cumple. Eso es 403, no un 200
   * silencioso ni un 404 que dijera que el punto desaparecio.
   *
   * Esta prueba mide el MANEJO de cero filas; que el EXISTS este de verdad en la
   * sentencia lo miden las dos de abajo, contra el SQL que se manda. Un mock no
   * filtra filas por si mismo, asi que separar las dos cosas es lo unico honesto:
   * la trampa conocida del repo es el test que confirma lo que el autor ya creia.
   */
  it('si el recinto deja de ser suyo entre comprobar y escribir, el UPDATE no toca nada y sale 403', async () => {
    const { service, query } = armar({
      respuestas: [
        [SQL_PUNTO, puntoEn(RECINTO_PROPIO)],
        // El UPDATE ya lleva el EXISTS: cero filas.
        ['UPDATE checkpoints', comoDriver([])],
      ],
    });

    await expect(service.updateCheckpoint('cp-1', SUPERVISOR, { name: 'Bodega 2' })).rejects.toThrow(
      ForbiddenException,
    );
    expect(query).toHaveBeenCalled();
  });

  it('el UPDATE del supervisor lleva el EXISTS sobre supervisor_sites y su id como parametro', async () => {
    const { service, query } = armar({
      respuestas: [
        [SQL_PUNTO, puntoEn(RECINTO_PROPIO)],
        ['UPDATE checkpoints', comoDriver([{ id: 'cp-1' }])],
        [SQL_ACTOR, [{ label: 'Ana Pérez' }]],
      ],
    });

    await service.updateCheckpoint('cp-1', SUPERVISOR, { name: 'Bodega 2' });

    const update = query.mock.calls.find(([sql]: [string]) => sql.includes('UPDATE checkpoints')) as
      | [string, unknown[]]
      | undefined;
    expect(update?.[0]).toContain('EXISTS (SELECT 1 FROM supervisor_sites');
    expect(update?.[0]).toContain('ss.site_id = checkpoints.site_id');
    expect(update?.[1]).toContain(SUPERVISOR);
  });

  it('retirar una etiqueta ata el UPDATE a supervisor_sites saltando por checkpoints', async () => {
    const { service, query } = armar({
      respuestas: [
        [SQL_ETIQUETA, [{ tag_id: 'tag-1', ...puntoEn(RECINTO_PROPIO)[0] }]],
        ['UPDATE tags', comoDriver([{ id: 'tag-1' }])],
        [SQL_ACTOR, [{ label: 'Ana Pérez' }]],
      ],
    });

    await service.retireTag('tag-1', SUPERVISOR);

    const update = query.mock.calls.find(([sql]: [string]) => sql.includes('UPDATE tags')) as
      | [string, unknown[]]
      | undefined;
    expect(update?.[0]).toContain('JOIN supervisor_sites ss ON ss.site_id = c.site_id');
    expect(update?.[0]).toContain('c.id = tags.checkpoint_id');
    expect(update?.[1]).toContain(SUPERVISOR);
  });

  /**
   * El camino del ADMIN opera sobre el tenant entero y NO manda supervisorId:
   * si el EXISTS se colara ahi, el admin dejaria de poder editar los puntos de
   * los recintos que no tienen supervisor asignado — que es la mitad del
   * catalogo recien creado.
   */
  it('el camino del ADMIN no lleva el EXISTS: opera sobre el tenant entero', async () => {
    const { admin, query } = armar({
      respuestas: [
        ['UPDATE checkpoints', comoDriver([{ id: 'cp-1' }])],
        [SQL_ACTOR, [{ label: 'Admin Tenant' }]],
      ],
    });

    await admin.updateCheckpoint('cp-1', { name: 'Bodega' }, { actorId: 'admin-1' });

    const update = query.mock.calls.find(([sql]: [string]) => sql.includes('UPDATE checkpoints')) as
      | [string, unknown[]]
      | undefined;
    expect(update?.[0]).not.toContain('supervisor_sites');
    expect(update?.[1]).toEqual(['cp-1', 'Bodega']);
  });
});

describe('#309 — las puertas laterales que convertirian el permiso en acceso al tenant', () => {
  /**
   * Auto-asignacion: si el SUPERVISOR pudiera llamar a
   * `PATCH /admin/users/:userId/sites/:siteId`, se agregaria a `supervisor_sites`
   * el recinto que quisiera y la restriccion entera dejaria de existir. Esa ruta
   * pide `tenant:users:manage` Y `tenant:sites:manage`, y el supervisor no tiene
   * ninguno de los dos. Va con prueba propia aunque "obviamente" este cerrada:
   * es la unica que convierte este issue en un incidente.
   */
  it('el SUPERVISOR no puede asignarse recintos: no tiene ninguno de los dos permisos que exige esa ruta', () => {
    expect(hasPermission('SUPERVISOR', 'tenant:users:manage')).toBe(false);
    expect(hasPermission('SUPERVISOR', 'tenant:sites:manage')).toBe(false);
  });

  /** El permiso nuevo NO ensancha el viejo: los recintos siguen siendo del ADMIN. */
  it('`checkpoints:manage` es del SUPERVISOR y `tenant:sites:manage` sigue sin serlo', () => {
    expect(hasPermission('SUPERVISOR', 'checkpoints:manage')).toBe(true);
    expect(hasPermission('ADMIN', 'checkpoints:manage')).toBe(false);
    expect(hasPermission('GUARDIA', 'checkpoints:manage')).toBe(false);
    expect(hasPermission('SUPERADMIN', 'checkpoints:manage')).toBe(false);
  });

  /**
   * El oraculo de etiquetas: `GET /admin/tags/resolve` contesta a que punto
   * pertenece un UID en TODO el tenant. Expuesto al supervisor seria un mapa
   * completo de los recintos que no son suyos, asi que no esta en el servicio
   * nuevo. Esta prueba se cae el dia que alguien lo agregue sin pensarlo.
   */
  it('el servicio del supervisor no expone resolveTag ni el override de foto', () => {
    const metodos = Object.getOwnPropertyNames(PuntosSupervisorService.prototype);
    expect(metodos).not.toContain('resolveTag');
    expect(metodos).not.toContain('setCheckpointPhoto');
    expect(metodos).not.toContain('createSite');
    expect(metodos).not.toContain('setSupervisorSite');
  });
});

describe('PuntosSupervisorService — auditoria de terreno (#309)', () => {
  it('el alta de un punto deja linea con el actor del token', async () => {
    const { service, record } = armar({
      respuestas: [
        ['SELECT id, name FROM sites', [{ id: RECINTO_PROPIO, name: 'Planta Sur' }]],
        [SQL_ACTOR, [{ label: 'Ana Pérez' }]],
      ],
    });

    await service.createCheckpoint(RECINTO_PROPIO, SUPERVISOR, { name: 'Bodega' });

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: SUPERVISOR,
        actorLabel: 'Ana Pérez',
        action: 'punto.creado',
        entityType: 'checkpoint',
      }),
    );
  });

  /**
   * El REEMPLAZO es la señal que importa, no el alta: quien re-vincula una
   * etiqueta puede simular presencia (una calcomania nueva pegada en la caseta y
   * el punto lejano queda "visitado"). Por eso el resumen tiene que nombrar la
   * etiqueta que se retiro.
   */
  it('vincular una etiqueta deja linea, y si hubo reemplazo el resumen lo dice', async () => {
    const { service, record } = armar({
      respuestas: [
        [SQL_PUNTO, puntoEn(RECINTO_PROPIO)],
        ['UPDATE tags', comoDriver([{ id: 'tag-vieja' }])],
        [SQL_ACTOR, [{ label: 'Ana Pérez' }]],
      ],
    });

    await service.registerTag('cp-1', SUPERVISOR, { uid: '04AABBCC' });

    const entrada = record.mock.calls[0]?.[0] as { action: string; summary: string };
    expect(entrada.action).toBe('etiqueta.registrada');
    expect(entrada.summary).toContain('04AABBCC');
    expect(entrada.summary).toContain('REEMPLAZA');
    expect(entrada.summary).toContain('Bodega');
  });

  it('mover las coordenadas de un punto queda dicho con todas sus letras', async () => {
    const { service, record } = armar({
      respuestas: [
        [SQL_PUNTO, puntoEn(RECINTO_PROPIO)],
        ['UPDATE checkpoints', comoDriver([{ id: 'cp-1' }])],
        [SQL_ACTOR, [{ label: 'Ana Pérez' }]],
      ],
    });

    await service.updateCheckpoint('cp-1', SUPERVISOR, { latitude: -33.4, longitude: -70.6 });

    const entrada = record.mock.calls[0]?.[0] as { action: string; summary: string };
    expect(entrada.action).toBe('punto.modificado');
    expect(entrada.summary).toContain('COORDENADAS');
  });

  it('no se registra nada de la persona: el resumen no lleva nombres de guardias', async () => {
    const { service, record } = armar({
      respuestas: [
        [SQL_ETIQUETA, [{ tag_id: 'tag-1', ...puntoEn(RECINTO_PROPIO)[0] }]],
        ['UPDATE tags', comoDriver([{ id: 'tag-1' }])],
        [SQL_ACTOR, [{ label: 'Ana Pérez' }]],
      ],
    });

    await service.retireTag('tag-1', SUPERVISOR);

    const entrada = record.mock.calls[0]?.[0] as { summary: string };
    expect(entrada.summary).toBe('Etiqueta retirada de "Bodega" (Planta Sur)');
  });

  /** Un 403 por recinto ajeno NO va a audit_log: se llenaria la tabla del tenant. */
  it('un 403 por recinto ajeno no escribe en el registro de auditoria', async () => {
    const { service, record } = armar({
      respuestas: [[SQL_PUNTO, puntoEn(RECINTO_AJENO)]],
    });

    await expect(service.updateCheckpoint('cp-1', SUPERVISOR, { name: 'x' })).rejects.toThrow(
      ForbiddenException,
    );
    expect(record).not.toHaveBeenCalled();
  });
});
