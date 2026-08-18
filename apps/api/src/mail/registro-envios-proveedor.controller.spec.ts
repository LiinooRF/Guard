import { ForbiddenException, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import type { DataSource } from 'typeorm';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { RegistroEnviosProveedorController } from './registro-envios-proveedor.controller';
import type { RegistroCorrelacionService } from './registro-envios.correlacion';
import { firmar } from './registro-envios.firma';
import { RegistroEnviosModule } from './registro-envios.module';
import { RegistroEnviosService } from './registro-envios.service';
import { TRADUCTOR_WEBHOOK, type Traduccion, type TraductorWebhookCorreo } from './registro-envios.traductor';
import { TraductorContratoInterno } from './registro-envios.traductor-interno';
import type { EstadoEnvio } from './registro-envios.types';

// RegistroEnviosModule importa DatabaseModule, que al cargarse arma el DataSource
// y exige DATABASE_URL. Aca no se conecta a nada: lo unico que se comprueba del
// modulo es su cableado.
jest.mock('../database/database.module', () => ({ DatabaseModule: class DatabaseModuleFalso {} }));

const SECRETO ='secreto-de-pruebas-que-no-esta-en-ningun-entorno';
const TENANT = '00000000-0000-4000-8000-000000000001';
const REGISTRO = '00000000-0000-4000-8000-0000000000cc';
const MESSAGE_ID = 'abc123@sentrycore.example';
const AHORA_SEG = 1_756_000_000;
const AHORA_MS = AHORA_SEG * 1000;

/**
 * Fila de mail_deliveries falseada con el MISMO guardia que el UPDATE real:
 * solo cambia si el estado cambia de verdad y viene de uno abierto al proveedor.
 * Es lo que hace comprobable la idempotencia sin levantar PostgreSQL.
 *
 * El UPDATE devuelve `[filas, cantidad]`, que es lo que devuelve el driver de
 * Postgres. Un mock que devolviera `[{...}]` dejaria el test verde y la
 * respuesta rota.
 */
function baseFalsa(inicial: { status: EstadoEnvio; enviado: boolean }) {
  const fila = { ...inicial, ultimoError: null as string | null };

  const query = jest.fn((sql: string, params: unknown[] = []): Promise<unknown> => {
    if (sql.includes('UPDATE mail_deliveries')) {
      const evento = params[1] as EstadoEnvio;
      const motivo = params[3] as string | null;
      const aplica =
        fila.enviado && fila.status !== evento && ['enviado', 'entregado'].includes(fila.status);
      if (!aplica) return Promise.resolve([[], 0]);
      fila.status = evento;
      fila.ultimoError = motivo ?? fila.ultimoError;
      return Promise.resolve([[{ id: REGISTRO }], 1]);
    }
    if (sql.includes('SELECT status FROM mail_deliveries')) {
      return Promise.resolve([{ status: fila.status }]);
    }
    return Promise.resolve([{ set_config: '' }]);
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

  const servicio = new RegistroEnviosService(
    { createQueryRunner: () => runner } as unknown as DataSource,
    {
      manager,
      run: <T,>(_runner: unknown, operacion: () => Promise<T>) => operacion(),
    } as unknown as TenantContextService,
    {
      recordar: jest.fn().mockResolvedValue(true),
      resolver: jest.fn().mockResolvedValue({ tenantId: TENANT, registroId: REGISTRO }),
    } as unknown as RegistroCorrelacionService,
  );

  return { servicio, fila, query };
}

/** Traductor de mentira, para los casos donde lo que se prueba es el controlador. */
function traductorFijo(traduccion: Traduccion): TraductorWebhookCorreo {
  return { nombre: 'falso', traducir: jest.fn().mockResolvedValue(traduccion) };
}

/** El request de Express: hoy sin `rawBody`, porque la app no levanta con el. */
const PETICION = {} as RawBodyRequest<Request>;

function cuerpoFirmado(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = { messageId: MESSAGE_ID, evento: 'entregado', timestamp: AHORA_SEG };
  const campos = { ...base, ...overrides };
  return {
    ...campos,
    firma: firmar(
      SECRETO,
      String(campos.messageId),
      String(campos.evento),
      Number(campos.timestamp),
    ),
  };
}

describe('RegistroEnviosProveedorController · firma', () => {
  it('responde 503 y lo deja en el log cuando el canal no tiene secreto', async () => {
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const controlador = new RegistroEnviosProveedorController(
      {} as RegistroEnviosService,
      traductorFijo({ ok: false, motivo: 'sin_secreto' }),
    );

    await expect(controlador.estadoEntrega({}, {}, PETICION)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    // 503 y no 403: el canal esta apagado de este lado, no es culpa de quien llama.
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('"event":"webhook_entrega_sin_secreto"'),
    );
    error.mockRestore();
  });

  it('rechaza con 403 y REGISTRA el intento cuando la firma no calza', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const servicio = { aplicarEventoProveedor: jest.fn() };
    const controlador = new RegistroEnviosProveedorController(
      servicio as unknown as RegistroEnviosService,
      traductorFijo({ ok: false, motivo: 'firma_invalida' }),
    );

    await expect(controlador.estadoEntrega({}, {}, PETICION)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('"event":"webhook_entrega_rechazado"'),
    );
    expect(warn.mock.calls[0]?.[0]).toContain('"motivo":"firma_invalida"');
    // Y nada llego al registro.
    expect(servicio.aplicarEventoProveedor).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('no filtra a un desconocido nada de lo que mando', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const controlador = new RegistroEnviosProveedorController(
      {} as RegistroEnviosService,
      // El traductor real, con el cuerpo real: lo que se mira es el log.
      new TraductorContratoInterno(SECRETO),
    );

    await expect(
      controlador.estadoEntrega(
        { messageId: 'jefe@cliente.cl', evento: 'rebotado', timestamp: AHORA_SEG, firma: 'f'.repeat(64) },
        {},
        PETICION,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const registrado = String(warn.mock.calls[0]?.[0]);
    expect(registrado).not.toContain('jefe@cliente.cl');
    warn.mockRestore();
  });
});

describe('RegistroEnviosProveedorController · idempotencia', () => {
  it('el mismo evento dos veces cambia el estado una sola vez', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { servicio, fila } = baseFalsa({ status: 'enviado', enviado: true });
    const controlador = new RegistroEnviosProveedorController(
      servicio,
      new TraductorContratoInterno(SECRETO),
    );
    jest.spyOn(Date, 'now').mockReturnValue(AHORA_MS);

    const cuerpo = cuerpoFirmado();
    await expect(controlador.estadoEntrega(cuerpo, {}, PETICION)).resolves.toEqual({
      recibidos: 1,
      aplicados: 1,
    });
    expect(fila.status).toBe('entregado');

    // El proveedor reenvia el MISMO evento, que es lo que hacen todos.
    await expect(controlador.estadoEntrega(cuerpo, {}, PETICION)).resolves.toEqual({
      recibidos: 1,
      aplicados: 0,
    });
    expect(fila.status).toBe('entregado');

    jest.restoreAllMocks();
    log.mockRestore();
  });

  it('un rebote repetido no pisa el motivo con el segundo intento', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { servicio, fila } = baseFalsa({ status: 'enviado', enviado: true });
    const controlador = new RegistroEnviosProveedorController(
      servicio,
      new TraductorContratoInterno(SECRETO),
    );
    jest.spyOn(Date, 'now').mockReturnValue(AHORA_MS);

    const rebote = cuerpoFirmado({ evento: 'rebotado' });
    await controlador.estadoEntrega({ ...rebote, motivo: '550 casilla inexistente' }, {}, PETICION);
    await controlador.estadoEntrega({ ...rebote, motivo: 'otro texto' }, {}, PETICION);

    expect(fila.status).toBe('rebotado');
    expect(fila.ultimoError).toBe('550 casilla inexistente');

    jest.restoreAllMocks();
    log.mockRestore();
  });

  it('un evento que llega antes de que el envio se registre no se aplica y no rompe', async () => {
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const { servicio, fila } = baseFalsa({ status: 'encolado', enviado: false });
    const controlador = new RegistroEnviosProveedorController(
      servicio,
      new TraductorContratoInterno(SECRETO),
    );
    jest.spyOn(Date, 'now').mockReturnValue(AHORA_MS);

    await expect(controlador.estadoEntrega(cuerpoFirmado(), {}, PETICION)).resolves.toEqual({
      recibidos: 1,
      aplicados: 0,
    });
    // No hay entrega sin envio: lo exige el CHECK mail_deliveries_entrega_check.
    expect(fila.status).toBe('encolado');

    jest.restoreAllMocks();
    log.mockRestore();
  });
});

describe('RegistroEnviosProveedorController · lotes y silencio', () => {
  it('aplica cada evento del lote y devuelve el conteo, no el detalle', async () => {
    const servicio = {
      aplicarEventoProveedor: jest
        .fn()
        .mockResolvedValueOnce({ aplicado: true, ignorado: null })
        .mockResolvedValueOnce({ aplicado: false, ignorado: 'sin_correlacion' }),
    };
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const controlador = new RegistroEnviosProveedorController(
      servicio as unknown as RegistroEnviosService,
      traductorFijo({
        ok: true,
        eventos: [
          { messageId: MESSAGE_ID, evento: 'entregado', ocurridoEn: new Date(AHORA_MS) },
          { messageId: 'otro@sentrycore.example', evento: 'rebotado', ocurridoEn: new Date(AHORA_MS) },
        ],
      }),
    );

    await expect(controlador.estadoEntrega([], {}, PETICION)).resolves.toEqual({
      recibidos: 2,
      aplicados: 1,
    });
    expect(servicio.aplicarEventoProveedor).toHaveBeenCalledTimes(2);

    // Lo que no se aplico queda en el log, agrupado y sin Message-ID ni correo.
    const registrado = String(log.mock.calls[0]?.[0]);
    expect(registrado).toContain('"motivos":{"sin_correlacion":1}');
    expect(registrado).not.toContain(MESSAGE_ID);
    log.mockRestore();
  });

  it('un evento que el registro no modela responde 202 sin tocar nada', async () => {
    const servicio = { aplicarEventoProveedor: jest.fn() };
    const controlador = new RegistroEnviosProveedorController(
      servicio as unknown as RegistroEnviosService,
      traductorFijo({ ok: true, eventos: [] }),
    );

    await expect(controlador.estadoEntrega({}, {}, PETICION)).resolves.toEqual({
      recibidos: 0,
      aplicados: 0,
    });
    expect(servicio.aplicarEventoProveedor).not.toHaveBeenCalled();
  });
});

describe('RegistroEnviosModule', () => {
  // Un traductor que existe y que nadie registra es un endpoint que responde 500
  // en produccion con todos los tests en verde.
  it('registra el traductor y expone el controlador publico', () => {
    const controladores = Reflect.getMetadata('controllers', RegistroEnviosModule) as unknown[];
    const proveedores = Reflect.getMetadata('providers', RegistroEnviosModule) as Array<{
      provide?: unknown;
    }>;

    expect(controladores).toContain(RegistroEnviosProveedorController);
    expect(proveedores.some((p) => p?.provide === TRADUCTOR_WEBHOOK)).toBe(true);
  });
});
