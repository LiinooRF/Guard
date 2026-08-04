import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { MAIL_JOB_ATTEMPTS } from './mail-queue.constants';
import type { MailJobData } from './mail-queue.types';
import type { RegistroCorrelacionService } from './registro-envios.correlacion';
import {
  normalizarCorreo,
  plantillaDesdeClave,
  RegistroEnviosService,
  resultadoDeEscritura,
  sanearMotivo,
} from './registro-envios.service';

const TENANT = '00000000-0000-4000-8000-000000000001';
const RONDA = '00000000-0000-4000-8000-0000000000aa';
const RECINTO = '00000000-0000-4000-8000-0000000000bb';
const REGISTRO = '00000000-0000-4000-8000-0000000000cc';
const JOB = 'a'.repeat(64);

interface Consulta {
  sql: string;
  params: unknown[];
}

type Responder = (sql: string, params: unknown[]) => unknown;

/**
 * Arma el servicio con la base falseada.
 *
 * El mismo `responder` atiende las consultas de la transaccion propia y las de
 * la vista de soporte: asi un test ve el orden completo de lo que se ejecuto,
 * incluido el `set_config` que abre el contexto de tenant.
 */
function armar(responder: Responder, correlacion: Partial<RegistroCorrelacionService> = {}) {
  const consultas: Consulta[] = [];
  const query = jest.fn((sql: string, params: unknown[] = []) => {
    consultas.push({ sql, params });
    return Promise.resolve(responder(sql, params));
  });

  const manager = { query };
  const runner = {
    connect: jest.fn().mockResolvedValue(undefined),
    startTransaction: jest.fn().mockResolvedValue(undefined),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
    release: jest.fn().mockResolvedValue(undefined),
    manager,
  };
  const dataSource = { createQueryRunner: () => runner } as unknown as DataSource;
  const contexto = {
    manager,
    run: <T>(_runner: unknown, operacion: () => Promise<T>) => operacion(),
  } as unknown as TenantContextService;

  const servicio = new RegistroEnviosService(
    dataSource,
    contexto,
    {
      recordar: jest.fn().mockResolvedValue(true),
      resolver: jest.fn().mockResolvedValue(null),
      ...correlacion,
    } as unknown as RegistroCorrelacionService,
  );

  return { servicio, consultas, runner };
}

const CONTEXTO_ABIERTO = [{ set_config: '' }];

function jobDeCorreo(overrides: Partial<MailJobData> = {}, attemptsMade = 0) {
  const data: MailJobData = {
    to: 'jefe@cliente.cl',
    tenantId: TENANT,
    template: { subject: 'Informe', text: 'Listo' },
    variables: {},
    ...overrides,
  };
  return { id: JOB, data, attemptsMade };
}

describe('RegistroEnviosService · escritura', () => {
  it('registra el correo al encolarlo, con el destinatario normalizado', async () => {
    const { servicio, consultas } = armar((sql) =>
      sql.includes('INSERT INTO mail_deliveries') ? [{ id: REGISTRO }] : CONTEXTO_ABIERTO,
    );

    const id = await servicio.registrarEncolado(
      jobDeCorreo({ to: 'Jefe de Turno <JEFE@Cliente.CL>' }).data,
      JOB,
      { plantilla: 'informe-ronda', patrolId: RONDA },
    );

    expect(id).toBe(REGISTRO);
    const insert = consultas.find((c) => c.sql.includes('INSERT INTO mail_deliveries'));
    expect(insert?.params).toEqual(['informe-ronda', 'jefe@cliente.cl', null, RONDA, JOB]);
    // El tenant no viaja como parametro: sale de app_tenant_id(), que es lo que
    // la politica RLS exige en el WITH CHECK.
    expect(insert?.sql).toContain('VALUES (app_tenant_id()');
    expect(insert?.sql).toContain('ON CONFLICT (tenant_id, job_id) DO NOTHING');
  });

  it('abre el contexto de tenant con SET LOCAL y no con SET', async () => {
    const { servicio, consultas } = armar((sql) =>
      sql.includes('INSERT INTO mail_deliveries') ? [{ id: REGISTRO }] : CONTEXTO_ABIERTO,
    );

    await servicio.registrarEncolado(jobDeCorreo().data, JOB, { plantilla: 'informe-ronda' });

    // El tercer parametro en true es SET LOCAL: muere con la transaccion y no
    // queda pegado a la conexion del pool para el siguiente job.
    expect(consultas[0]?.sql).toContain("set_config('app.tenant_id', $1, true)");
    expect(consultas[0]?.sql).not.toMatch(/\bSET\s+app\.tenant_id\b/i);
    expect(consultas[0]?.params).toEqual([TENANT]);
  });

  it('no registra los correos sin tenant: la tabla es de negocio y lleva tenant_id', async () => {
    const { servicio, consultas } = armar(() => CONTEXTO_ABIERTO);

    const id = await servicio.registrarEncolado(jobDeCorreo({ tenantId: null }).data, JOB);

    expect(id).toBeNull();
    expect(consultas).toHaveLength(0);
  });

  it('marca el envio leyendo [filas, cantidad], que es lo que devuelve un UPDATE', async () => {
    const recordar = jest.fn().mockResolvedValue(true);
    const { servicio, consultas } = armar(
      (sql) => (sql.includes('UPDATE mail_deliveries') ? [[{ id: REGISTRO }], 1] : CONTEXTO_ABIERTO),
      { recordar },
    );

    await servicio.registrarEnviado(jobDeCorreo(), {
      messageId: '<abc@voxia.example>',
      accepted: ['jefe@cliente.cl'],
      rejected: [],
    });

    const update = consultas.find((c) => c.sql.includes('UPDATE mail_deliveries'));
    expect(update?.params).toEqual([JOB, '<abc@voxia.example>', 1]);
    expect(update?.sql).toContain("status = 'enviado'");
    // La correlacion se guarda con el id de la FILA, no con el del job: es lo
    // que el webhook necesita para actualizar sin adivinar el tenant.
    expect(recordar).toHaveBeenCalledWith('<abc@voxia.example>', {
      tenantId: TENANT,
      registroId: REGISTRO,
    });
  });

  it('no correlaciona nada cuando el UPDATE no encontro fila', async () => {
    const recordar = jest.fn();
    const { servicio } = armar(
      (sql) => (sql.includes('UPDATE mail_deliveries') ? [[], 0] : CONTEXTO_ABIERTO),
      { recordar },
    );

    await servicio.registrarEnviado(jobDeCorreo(), {
      messageId: '<abc@voxia.example>',
      accepted: [],
      rejected: [],
    });

    expect(recordar).not.toHaveBeenCalled();
  });

  it('mantiene el correo en cola mientras queden reintentos y lo da por fallido al ultimo', async () => {
    const responder: Responder = (sql) =>
      sql.includes('UPDATE mail_deliveries') ? [[{ id: REGISTRO }], 1] : CONTEXTO_ABIERTO;

    const primero = armar(responder);
    await primero.servicio.registrarFallido(jobDeCorreo({}, 0), new Error('conexión rechazada'));
    expect(
      primero.consultas.find((c) => c.sql.includes('UPDATE mail_deliveries'))?.params,
    ).toEqual([JOB, 1, 'conexión rechazada', false]);

    const ultimo = armar(responder);
    await ultimo.servicio.registrarFallido(
      jobDeCorreo({}, MAIL_JOB_ATTEMPTS - 1),
      new Error('conexión rechazada'),
    );
    expect(ultimo.consultas.find((c) => c.sql.includes('UPDATE mail_deliveries'))?.params).toEqual([
      JOB,
      MAIL_JOB_ATTEMPTS,
      'conexión rechazada',
      true,
    ]);
  });

  it('nunca rompe el correo: si el registro falla, se traga el error', async () => {
    const { servicio } = armar((sql) => {
      if (sql.includes('INSERT INTO mail_deliveries')) throw new Error('base caida');
      return CONTEXTO_ABIERTO;
    });

    await expect(
      servicio.registrarEncolado(jobDeCorreo().data, JOB, { plantilla: 'informe-ronda' }),
    ).resolves.toBeNull();
  });
});

describe('RegistroEnviosService · estado del proveedor', () => {
  it('ignora el evento cuando ya no se sabe de quien era el mensaje', async () => {
    const { servicio, consultas } = armar(() => CONTEXTO_ABIERTO, {
      resolver: jest.fn().mockResolvedValue(null),
    });

    await expect(
      servicio.aplicarEventoProveedor({
        messageId: 'abc@voxia.example',
        evento: 'entregado',
        ocurridoEn: new Date('2026-08-03T12:00:00.000Z'),
      }),
    ).resolves.toEqual({ aplicado: false, ignorado: 'sin_correlacion' });
    // Sin correlacion no se abre transaccion contra ningun tenant.
    expect(consultas).toHaveLength(0);
  });

  it('aplica la entrega sobre el tenant que dijo la correlacion, no sobre uno del cuerpo', async () => {
    const { servicio, consultas } = armar(
      (sql) => (sql.includes('UPDATE mail_deliveries') ? [[{ id: REGISTRO }], 1] : CONTEXTO_ABIERTO),
      { resolver: jest.fn().mockResolvedValue({ tenantId: TENANT, registroId: REGISTRO }) },
    );

    await expect(
      servicio.aplicarEventoProveedor({
        messageId: 'abc@voxia.example',
        evento: 'entregado',
        ocurridoEn: new Date('2026-08-03T12:00:00.000Z'),
        motivo: null,
      }),
    ).resolves.toEqual({ aplicado: true, ignorado: null });

    expect(consultas[0]?.params).toEqual([TENANT]);
    const update = consultas.find((c) => c.sql.includes('UPDATE mail_deliveries'));
    expect(update?.params).toEqual([
      REGISTRO,
      'entregado',
      '2026-08-03T12:00:00.000Z',
      null,
    ]);
    // No se pisa un estado ya reportado ni se retrocede desde un rebote.
    expect(update?.sql).toContain("status IN ('enviado', 'entregado')");
    // Y no hay entrega sin envio: el CHECK de la tabla lo exige.
    expect(update?.sql).toContain('sent_at IS NOT NULL');
  });

  it('distingue el evento repetido del mensaje que no existe', async () => {
    const { servicio } = armar(
      (sql) => {
        if (sql.includes('UPDATE mail_deliveries')) return [[], 0];
        if (sql.includes('SELECT status FROM mail_deliveries')) return [{ status: 'entregado' }];
        return CONTEXTO_ABIERTO;
      },
      { resolver: jest.fn().mockResolvedValue({ tenantId: TENANT, registroId: REGISTRO }) },
    );

    await expect(
      servicio.aplicarEventoProveedor({
        messageId: 'abc@voxia.example',
        evento: 'entregado',
        ocurridoEn: new Date('2026-08-03T12:00:00.000Z'),
      }),
    ).resolves.toEqual({ aplicado: false, ignorado: 'estado_no_aplica' });
  });
});

describe('RegistroEnviosService · vista de soporte', () => {
  it('responde que se envio de la ronda y a quien', async () => {
    const { servicio } = armar((sql) => {
      if (sql.includes('FROM patrols')) return [{ site_id: RECINTO, status: 'completada' }];
      if (sql.includes('FROM mail_deliveries')) {
        return [
          {
            id: REGISTRO,
            template_key: 'report-dispatch:informe',
            recipient_email: 'jefe@cliente.cl',
            recipient_user_id: null,
            patrol_id: RONDA,
            status: 'entregado',
            attempts: 1,
            last_error: null,
            queued_at: new Date('2026-08-03T12:00:00.000Z'),
            sent_at: new Date('2026-08-03T12:00:05.000Z'),
            delivered_at: new Date('2026-08-03T12:00:09.000Z'),
            failed_at: null,
          },
        ];
      }
      return CONTEXTO_ABIERTO;
    });

    const resultado = await servicio.porRonda(RONDA, { sub: 'admin', role: 'ADMIN' });

    expect(resultado.envios).toHaveLength(1);
    expect(resultado.envios[0]).toMatchObject({
      destinatario: 'jefe@cliente.cl',
      estado: 'entregado',
      plantilla: 'report-dispatch:informe',
    });
  });

  it('el SUPERVISOR solo ve rondas de sus recintos asignados', async () => {
    const { servicio } = armar((sql) => {
      if (sql.includes('FROM patrols')) return [{ site_id: RECINTO, status: 'completada' }];
      if (sql.includes('FROM supervisor_sites')) return [];
      return CONTEXTO_ABIERTO;
    });

    await expect(
      servicio.porRonda(RONDA, { sub: 'supervisor', role: 'SUPERVISOR' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('404 cuando la ronda no existe o es de otra empresa (RLS la esconde igual)', async () => {
    const { servicio } = armar((sql) => (sql.includes('FROM patrols') ? [] : CONTEXTO_ABIERTO));

    await expect(
      servicio.porRonda(RONDA, { sub: 'admin', role: 'ADMIN' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('exige recinto para filtrar por fechas: el periodo es de la zona horaria del recinto', async () => {
    const { servicio } = armar(() => []);

    await expect(servicio.listar({ desde: '2026-08-01' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('suma el dia al timestamp SIN zona y recien despues convierte', async () => {
    const { servicio, consultas } = armar((sql) => {
      if (sql.includes('FROM sites')) return [{ timezone: 'Pacific/Easter' }];
      return [];
    });

    await servicio.listar({ siteId: RECINTO, desde: '2026-08-01', hasta: '2026-08-03' });

    const listado = consultas.find((c) => c.sql.includes('FROM mail_deliveries'));
    // El +1 va sobre la fecha, ANTES del AT TIME ZONE. Convertir primero y sumar
    // despues da 24 horas fijas y se equivoca en los cambios de horario, donde
    // el dia local dura 23 o 25.
    expect(listado?.sql).toContain("($5::date + 1)::timestamp AT TIME ZONE $6::text");
    // La zona sale del RECINTO, no del servidor ni del navegador.
    expect(listado?.params?.[5]).toBe('Pacific/Easter');
  });

  it('el filtro de recinto no se lleva puesto el correo que no es de una ronda', async () => {
    const { servicio, consultas } = armar((sql) => {
      if (sql.includes('FROM sites')) return [{ timezone: 'America/Santiago' }];
      return [];
    });

    await servicio.listar({ siteId: RECINTO, desde: '2026-08-01' });

    const listado = consultas.find((c) => c.sql.includes('FROM mail_deliveries'));
    // Un correo solo tiene recinto si tiene ronda, y patrol_id es NULL en las
    // invitaciones, las claves y los escalamientos. Como filtrar por fecha
    // OBLIGA a mandar siteId, sin este OR la vista se vaciaria justo en su uso
    // normal y en silencio: el LEFT JOIN deja p.site_id en NULL y la comparacion
    // descarta la fila.
    expect(listado?.sql).toContain('OR md.patrol_id IS NULL');
    expect(listado?.params?.[0]).toBe(RECINTO);
  });

  it('acota el limite pedido al maximo de la pagina', async () => {
    const { servicio, consultas } = armar(() => []);

    await servicio.listar({ limite: 10_000 });

    const listado = consultas.find((c) => c.sql.includes('FROM mail_deliveries'));
    expect(listado?.params?.[6]).toBe(200);
  });
});

describe('RegistroEnviosService · purgado', () => {
  it('devuelve la cantidad borrada, que viene en el segundo elemento del DELETE', async () => {
    const { servicio, consultas } = armar((sql) =>
      sql.includes('DELETE FROM mail_deliveries') ? [[], 17] : CONTEXTO_ABIERTO,
    );

    await expect(servicio.purgar(TENANT, 180)).resolves.toBe(17);
    expect(consultas.find((c) => c.sql.includes('DELETE'))?.params).toEqual([180]);
  });

  it('no acepta una retencion que no sea un numero de dias', async () => {
    const { servicio } = armar(() => CONTEXTO_ABIERTO);
    await expect(servicio.purgar(TENANT, 0)).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('resultadoDeEscritura', () => {
  it('lee la tupla [filas, cantidad] que devuelve PostgreSQL en UPDATE y DELETE', () => {
    expect(resultadoDeEscritura<{ id: string }>([[{ id: 'x' }], 1])).toEqual({
      filas: [{ id: 'x' }],
      cantidad: 1,
    });
  });

  it('revienta si le pasan un arreglo de filas: es el mock que dejaba el bug en verde', () => {
    // TypeORM devuelve [filas, cantidad] mirando raw.command, aunque la consulta
    // lleve RETURNING. Un mock que devuelve [{ id }] hacia pasar el test con la
    // respuesta rota, y por eso aca no hay rama de compatibilidad.
    expect(() => resultadoDeEscritura([{ id: 'x' }])).toThrow(/\[filas, cantidad\]/);
  });
});

describe('utilidades del registro', () => {
  it('deduce la plantilla desde la clave de idempotencia sin arrastrar identificadores', () => {
    expect(plantillaDesdeClave('report-dispatch:informe:0f1e2d3c-4b5a-4968-8776-655443332211:a@b.cl'))
      .toBe('report-dispatch:informe');
    expect(plantillaDesdeClave('escalation:0f1e2d3c-4b5a-4968-8776-655443332211:2')).toBe(
      'escalation',
    );
    expect(plantillaDesdeClave('0f1e2d3c-4b5a-4968-8776-655443332211')).toBe('sin-clasificar');
    expect(plantillaDesdeClave('')).toBe('sin-clasificar');
  });

  it('normaliza el destinatario venga pelado o con nombre', () => {
    expect(normalizarCorreo('  JEFE@Cliente.CL ')).toBe('jefe@cliente.cl');
    expect(normalizarCorreo('Jefe de Turno <JEFE@Cliente.CL>')).toBe('jefe@cliente.cl');
  });

  it('sanea el motivo del fallo: una linea, sin credenciales y recortado', () => {
    const motivo = sanearMotivo(
      new Error('535 auth failed AKIAIOSFODNN7EXAMPLEKEYVALUE123456\n    at Socket.<anonymous>'),
    );

    expect(motivo).toBe('535 auth failed [oculto]');
    expect(motivo).not.toContain('AKIA');
    expect(sanearMotivo('ab '.repeat(200))).toHaveLength(300);
  });
});
