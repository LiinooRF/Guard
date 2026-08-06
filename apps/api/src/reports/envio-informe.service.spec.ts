import { Logger } from '@nestjs/common';
import { patrolRulesSchema, type PatrolRules } from '@voxia/shared';
import type { Queue } from 'bullmq';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { MailQueueService } from '../mail/mail-queue.service';
import type { RulesService } from '../rules/rules.service';
import { resolverDominiosNoDespachables } from './envio-informe.dominios';
import { EnvioInformeService } from './envio-informe.service';
import { INFORME_AL_CIERRE, INFORME_BAJO_UMBRAL } from './envio-informe.plantillas';
import type { InformeRonda } from './patrol-report.model';
import type { PatrolReportService } from './patrol-report.service';

/**
 * Tests del envio automatico al cierre (#86).
 *
 * Lo que se prueba es la DECISION: a quien se le manda, con que asunto, y que
 * pasa cuando la misma ronda se reprocesa. El dibujo del PDF esta mockeado a
 * proposito — ya tiene sus propios tests en patrol-report.service.spec.ts.
 *
 * Los mocks devuelven la forma REAL del driver de PostgreSQL: `INSERT ...
 * RETURNING` entrega un arreglo plano de filas, y un ON CONFLICT DO NOTHING que
 * no inserta entrega el arreglo vacio. Esa es justamente la diferencia que hace
 * este servicio para decidir si el correo se manda o ya se habia mandado. Un
 * INSERT SIN `RETURNING` —el de `report_dispatch_attempts`— entrega tambien un
 * arreglo plano, vacio (TypeORM solo devuelve `[filas, cantidad]` para UPDATE y
 * DELETE), y por eso el servicio no lee nada de esa llamada.
 */

const TENANT = 'a0000000-0000-4000-8000-000000000001';
const PATRULLA = 'b0000000-0000-4000-8000-000000000009';
const SITIO = 'c0000000-0000-4000-8000-000000000007';

/** La lista de fabrica: la que corre en staging si nadie configura nada. */
const DOMINIOS_DE_FABRICA = resolverDominiosNoDespachables({});

const MODELO: InformeRonda = {
  patrolId: PATRULLA,
  filename: `informe-ronda-${PATRULLA}.pdf`,
  marca: {
    displayName: 'Vigilancia Austral Ltda',
    logoUri: null,
    primaryColor: '#7a1f1f',
    mailFooter: 'Vigilancia Austral Ltda · Región de Los Lagos',
  },
  timezone: 'America/Santiago',
  recinto: {
    nombre: 'Planta Norte',
    sucursal: 'Casa matriz',
    ruta: 'Ronda nocturna',
    guardia: 'Juan Soto',
  },
  ventana: {
    desde: new Date('2026-07-30T22:00:00-04:00'),
    hasta: new Date('2026-07-31T06:00:00-04:00'),
  },
  ejecucion: {
    inicio: new Date('2026-07-30T22:05:00-04:00'),
    cierre: new Date('2026-07-31T05:40:00-04:00'),
  },
  estado: 'completada',
  compliance: {
    expected: 5,
    scanned: 5,
    clean: 5,
    pct: 100,
    missedCheckpointIds: [],
    belowThreshold: false,
  },
  umbral: 70,
  puntos: [],
  omitidos: [],
  incidentes: [],
  anexo: [],
  incluyeAnexo: false,
};

function modeloCon(pct: number, omitidos: string[] = []): InformeRonda {
  return {
    ...MODELO,
    compliance: {
      expected: 5,
      scanned: 5 - omitidos.length,
      clean: 5 - omitidos.length,
      pct,
      missedCheckpointIds: omitidos,
      belowThreshold: pct < 70,
    },
  };
}

interface Fixture {
  ronda?: unknown[];
  admins?: unknown[];
  entregas?: Array<{ kind: string; recipient_email: string }>;
  /** Marca de "ya se atendio" que la base YA tenia antes de este despacho. */
  marcas?: Array<{ reason: string; attempted_at: Date }>;
  reglas?: Partial<PatrolRules>;
  modelo?: InformeRonda;
  /** Bytes que "pesa" el PDF dibujado. */
  pesoPdf?: number;
  /** Dominios que no se despachan. Por defecto, los de fabrica. */
  dominios?: readonly string[];
}

const ADMIN = { id: 'u-admin', email: 'Jefa@Empresa.cl' };
const ADMIN_DEMO = { id: 'u-demo', email: 'admin@demo-andina.test' };

/**
 * Manager falso que responde por el CONTENIDO del SQL y no por el orden de las
 * llamadas: asi un test no se rompe porque se agrego una consulta antes.
 */
function armar(fixture: Fixture = {}) {
  const registradas = new Set(
    (fixture.entregas ?? []).map((e) => `${e.kind}|${e.recipient_email}`),
  );
  /** Las marcas de "ya se atendio y no habia nada que mandar". */
  const atendidas: Array<{ patrolId: string; motivo: string }> = [];

  const manager = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO report_dispatch_attempts')) {
        atendidas.push({ patrolId: String(params?.[0]), motivo: String(params?.[1]) });
        // Sin RETURNING: el driver entrega un arreglo vacio.
        return [];
      }
      if (sql.includes('INSERT INTO report_deliveries')) {
        const clave = `${String(params?.[1])}|${String(params?.[2])}`;
        if (registradas.has(clave)) return [];
        registradas.add(clave);
        return [{ id: `entrega-${registradas.size}` }];
      }
      if (sql.includes('FROM report_dispatch_attempts')) {
        return fixture.marcas ?? [];
      }
      if (sql.includes('FROM report_deliveries')) {
        return (fixture.entregas ?? []).map((e) => ({ ...e }));
      }
      if (sql.includes('FROM memberships')) return fixture.admins ?? [ADMIN];
      if (sql.includes('FROM supervisor_sites')) return [];
      if (sql.includes('FROM patrols')) {
        return (
          fixture.ronda ?? [
            {
              tenant_id: TENANT,
              site_id: SITIO,
              status: 'completada',
              compliance_pct: '100.00',
            },
          ]
        );
      }
      throw new Error(`consulta no esperada: ${sql}`);
    }),
  };

  const modelo = fixture.modelo ?? MODELO;
  const informe = {
    buildModel: jest.fn().mockResolvedValue(modelo),
    // Igual que el render de verdad: la promesa resuelve recien cuando el
    // stream de destino termino. Resolver antes dejaria el buffer vacio y el
    // test del adjunto pasaria por la razon equivocada.
    render: jest.fn(async (_modelo: InformeRonda, destino: NodeJS.WritableStream) => {
      await new Promise<void>((resolve, reject) => {
        destino.on('finish', () => resolve());
        destino.on('error', reject);
        destino.write(Buffer.alloc(fixture.pesoPdf ?? 2048, 0x25));
        destino.end();
      });
      return { fotosIncluidas: 0, fotosOmitidas: 0, paginasAnexo: 0 };
    }),
  } as unknown as PatrolReportService;

  const mail = { enqueue: jest.fn().mockResolvedValue({ jobId: 'x' }) };
  const rules = {
    effective: jest.fn().mockResolvedValue(patrolRulesSchema.parse(fixture.reglas ?? {})),
  } as unknown as RulesService;
  const queue = { add: jest.fn().mockResolvedValue({ id: 'job-1' }) };

  const service = new EnvioInformeService(
    queue as unknown as Queue,
    { manager } as unknown as TenantContextService,
    informe,
    mail as unknown as MailQueueService,
    rules,
    fixture.dominios ?? DOMINIOS_DE_FABRICA,
  );

  return { service, manager, informe, mail, rules, queue, atendidas };
}

describe('EnvioInformeService', () => {
  describe('alCerrarRonda', () => {
    it('encola un despacho con jobId derivado de la ronda', async () => {
      const { service, queue } = armar();

      const primero = await service.alCerrarRonda(PATRULLA);
      const segundo = await service.alCerrarRonda(PATRULLA);

      expect(primero).not.toBeNull();
      expect(segundo).not.toBeNull();
      // Dos llamadas, MISMO jobId: BullMQ no crea el segundo job. Esto es lo que
      // hace que reprocesar una ronda no dispare un segundo despacho.
      const [, , opcionesA] = queue.add.mock.calls[0] as [string, unknown, { jobId: string }];
      const [, , opcionesB] = queue.add.mock.calls[1] as [string, unknown, { jobId: string }];
      expect(opcionesA.jobId).toBe(opcionesB.jobId);
      // Y no lleva datos de negocio legibles: es un hash.
      expect(opcionesA.jobId).toMatch(/^[0-9a-f]{64}$/);
    });

    it('no encola nada si la ronda todavia no esta cerrada', async () => {
      const { service, queue } = armar({
        ronda: [{ tenant_id: TENANT, site_id: SITIO, status: 'en_curso', compliance_pct: null }],
      });

      await expect(service.alCerrarRonda(PATRULLA)).resolves.toBeNull();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('despachar', () => {
    it('manda el informe a los administradores y a los correos configurados', async () => {
      const { service, mail } = armar({
        reglas: { reportRecipients: ['operaciones@cliente.cl'] },
      });

      const resultado = await service.despachar(TENANT, PATRULLA);

      expect(resultado.informes).toBe(2);
      expect(resultado.alertas).toBe(0);
      expect(resultado.adjunto).toBe(true);
      expect(resultado.suprimidos).toBe(0);
      expect(mail.enqueue).toHaveBeenCalledTimes(2);

      const destinos = mail.enqueue.mock.calls.map(([datos]) => (datos as { to: string }).to);
      // El correo del admin queda normalizado: la bitacora deduplica de verdad.
      expect(destinos).toEqual(['jefa@empresa.cl', 'operaciones@cliente.cl']);

      const [datos] = mail.enqueue.mock.calls[0] as [
        { template: unknown; attachments?: Array<{ filename: string }> },
      ];
      expect(datos.template).toBe(INFORME_AL_CIERRE);
      expect(datos.attachments?.[0]?.filename).toBe(MODELO.filename);
    });

    it('bajo el umbral suma la alerta al admin, con otro asunto', async () => {
      const { service, mail } = armar({
        modelo: modeloCon(60, ['cp-4', 'cp-5']),
        ronda: [
          { tenant_id: TENANT, site_id: SITIO, status: 'completada', compliance_pct: '60.00' },
        ],
        reglas: { reportRecipients: ['operaciones@cliente.cl'] },
      });

      const resultado = await service.despachar(TENANT, PATRULLA);

      // Dos informes (admin + correo configurado) y UNA alerta: solo al admin.
      expect(resultado.informes).toBe(2);
      expect(resultado.alertas).toBe(1);

      const plantillas = mail.enqueue.mock.calls.map(
        ([datos]) => (datos as { template: unknown }).template,
      );
      expect(plantillas).toContain(INFORME_BAJO_UMBRAL);
      expect(INFORME_BAJO_UMBRAL.subject).not.toBe(INFORME_AL_CIERRE.subject);

      const alerta = mail.enqueue.mock.calls.find(
        ([datos]) => (datos as { template: unknown }).template === INFORME_BAJO_UMBRAL,
      );
      expect((alerta?.[0] as { to: string }).to).toBe('jefa@empresa.cl');
      expect((alerta?.[1] as { idempotencyKey: string }).idempotencyKey).toContain('alerta');
    });

    it('reprocesar la ronda no reenvia nada ni vuelve a generar el PDF', async () => {
      const { service, mail, informe } = armar({
        entregas: [{ kind: 'informe', recipient_email: 'jefa@empresa.cl' }],
      });

      const resultado = await service.despachar(TENANT, PATRULLA);

      expect(resultado.omitido).toBe('ya_enviado');
      expect(mail.enqueue).not.toHaveBeenCalled();
      expect(informe.buildModel).not.toHaveBeenCalled();
    });

    it('con un destinatario nuevo manda solo al que falta', async () => {
      const { service, mail } = armar({
        entregas: [{ kind: 'informe', recipient_email: 'jefa@empresa.cl' }],
        reglas: { reportRecipients: ['operaciones@cliente.cl'] },
      });

      const resultado = await service.despachar(TENANT, PATRULLA);

      expect(resultado.informes).toBe(1);
      expect(mail.enqueue).toHaveBeenCalledTimes(1);
      expect((mail.enqueue.mock.calls[0]?.[0] as { to: string }).to).toBe(
        'operaciones@cliente.cl',
      );
    });

    it('con el envio automatico apagado no manda nada, pero deja marca', async () => {
      const { service, mail, informe, atendidas } = armar({
        reglas: { autoSendReportOnClose: false },
      });

      const resultado = await service.despachar(TENANT, PATRULLA);

      expect(resultado.omitido).toBe('envio_desactivado');
      expect(informe.buildModel).not.toHaveBeenCalled();
      expect(mail.enqueue).not.toHaveBeenCalled();
      // La marca es lo que impide que el barrido vuelva a levantar esta ronda
      // cada diez minutos durante las 48 h de la ventana de rescate, ocupando el
      // cupo de las rondas que si se perdieron.
      expect(atendidas).toEqual([{ patrolId: PATRULLA, motivo: 'envio_desactivado' }]);
    });

    it('con el envio apagado, la alerta bajo umbral igual sale', async () => {
      // Apagar el informe de todos los dias no puede apagar el aviso de que una
      // ronda se hizo a medias: son dos decisiones distintas.
      const { service, mail } = armar({
        reglas: { autoSendReportOnClose: false, reportRecipients: ['operaciones@cliente.cl'] },
        modelo: modeloCon(60, ['cp-4', 'cp-5']),
        ronda: [
          { tenant_id: TENANT, site_id: SITIO, status: 'completada', compliance_pct: '60.00' },
        ],
      });

      const resultado = await service.despachar(TENANT, PATRULLA);

      expect(resultado.informes).toBe(0);
      expect(resultado.alertas).toBe(1);
      expect(mail.enqueue).toHaveBeenCalledTimes(1);
      const [datos] = mail.enqueue.mock.calls[0] as [{ template: unknown; to: string }];
      expect(datos.template).toBe(INFORME_BAJO_UMBRAL);
      expect(datos.to).toBe('jefa@empresa.cl');
    });

    it('con el envio apagado y SIN cumplimiento persistido, la alerta se decide con el informe', async () => {
      // Una ronda cerrada por el reloj puede quedar con compliance_pct en NULL.
      // Tratar ese NULL como "sobre el umbral" apagaria la alerta justo en la
      // ronda que mas falta hace avisar, y ademas dejaria marca de atendida:
      // el barrido no volveria a mirarla nunca.
      const { service, mail, atendidas } = armar({
        reglas: { autoSendReportOnClose: false },
        modelo: modeloCon(0, ['cp-1', 'cp-2', 'cp-3', 'cp-4', 'cp-5']),
        ronda: [
          { tenant_id: TENANT, site_id: SITIO, status: 'vencida', compliance_pct: null },
        ],
      });

      const resultado = await service.despachar(TENANT, PATRULLA);

      expect(resultado.alertas).toBe(1);
      expect(resultado.informes).toBe(0);
      expect(atendidas).toEqual([]);
      expect((mail.enqueue.mock.calls[0]?.[0] as { template: unknown }).template).toBe(
        INFORME_BAJO_UMBRAL,
      );
    });

    it('con el envio apagado y el informe POR ENCIMA del umbral, no manda pero deja marca', async () => {
      // El otro lado de la misma moneda. `compliance_pct` en NULL hace que el
      // plan tentativo incluya la alerta (por prudencia, no se asume que la ronda
      // estuvo bien), pero el modelo recien calculado la deja sobre el umbral: el
      // plan definitivo queda VACIO.
      //
      // Sin marca no se escribe ninguna fila en report_deliveries NI en
      // report_dispatch_attempts, y report_dispatch_backlog() descuenta por una o
      // por la otra: la ronda volveria a salir rezagada en cada pasada del
      // barrido durante las 48 h de la ventana, ocupando el cupo de 200.
      const { service, mail, informe, atendidas } = armar({
        reglas: { autoSendReportOnClose: false },
        modelo: modeloCon(80, ['cp-5']),
        ronda: [
          { tenant_id: TENANT, site_id: SITIO, status: 'incompleta', compliance_pct: null },
        ],
      });

      const resultado = await service.despachar(TENANT, PATRULLA);

      expect(resultado.omitido).toBe('envio_desactivado');
      expect(resultado.informes).toBe(0);
      expect(resultado.alertas).toBe(0);
      expect(mail.enqueue).not.toHaveBeenCalled();
      expect(atendidas).toEqual([{ patrolId: PATRULLA, motivo: 'envio_desactivado' }]);
      // El PDF se dibujo y se tiro: es el costo asumido de decidir el veredicto
      // con el cumplimiento recien calculado y no con el persistido.
      expect(informe.buildModel).toHaveBeenCalledTimes(1);
    });

    it('sin destinatarios no manda y lo deja registrado', async () => {
      const { service, mail, atendidas } = armar({ admins: [] });

      const resultado = await service.despachar(TENANT, PATRULLA);

      expect(resultado.omitido).toBe('sin_destinatarios');
      expect(mail.enqueue).not.toHaveBeenCalled();
      expect(atendidas).toEqual([{ patrolId: PATRULLA, motivo: 'sin_destinatarios' }]);
    });

    it('un envio normal NO deja marca de atendida: para eso estan las entregas', async () => {
      // La marca es solo para las omisiones definitivas. Si un despacho que si
      // mando dejara marca, seria un segundo registro que puede contradecir a
      // report_deliveries, que es la bitacora de verdad.
      const { service, atendidas } = armar();

      const resultado = await service.despachar(TENANT, PATRULLA);

      expect(resultado.omitido).toBeNull();
      expect(atendidas).toEqual([]);
    });

    it('la ronda sin cerrar no deja marca: se reintenta, no se descarta', async () => {
      // Es transitoria (el job se encola dentro de la transaccion del escaneo y
      // puede llegar antes que el commit). Marcarla la sacaria del barrido para
      // siempre justo cuando todavia se puede rescatar.
      const { service, atendidas } = armar({
        ronda: [{ tenant_id: TENANT, site_id: SITIO, status: 'en_curso', compliance_pct: null }],
      });

      await service.despachar(TENANT, PATRULLA);

      expect(atendidas).toEqual([]);
    });

    it('una ronda sin cerrar no se despacha', async () => {
      const { service, mail } = armar({
        ronda: [{ tenant_id: TENANT, site_id: SITIO, status: 'en_curso', compliance_pct: null }],
      });

      const resultado = await service.despachar(TENANT, PATRULLA);

      expect(resultado.omitido).toBe('ronda_sin_cerrar');
      expect(mail.enqueue).not.toHaveBeenCalled();
    });

    it('si el PDF supera el maximo configurado, el correo sale sin adjunto', async () => {
      const { service, mail } = armar({
        reglas: { reportMailMaxAttachmentMB: 1 },
        pesoPdf: 2 * 1024 * 1024,
      });

      const resultado = await service.despachar(TENANT, PATRULLA);

      expect(resultado.adjunto).toBe(false);
      expect(resultado.informes).toBe(1);
      const [datos] = mail.enqueue.mock.calls[0] as [{ attachments?: unknown }];
      expect(datos.attachments).toBeUndefined();
    });

    it('las reglas se resuelven con el recinto de la ronda', async () => {
      const { service, rules } = armar();

      await service.despachar(TENANT, PATRULLA);

      expect(rules.effective).toHaveBeenCalledWith({ siteId: SITIO });
    });
  });

  // --------------------------------------------------- dominios no despachables

  describe('despachar — dominios que no se despachan', () => {
    it('la cuenta demo no recibe NADA, ni informe ni alerta', async () => {
      // `.test` esta reservado por RFC 6761 y nunca resuelve: cada correo a
      // @demo-andina.test es un rebote duro, y los rebotes duros son lo que
      // hace que el proveedor suspenda la cuenta de TODA la plataforma.
      const { service, mail, atendidas } = armar({
        admins: [ADMIN_DEMO],
        modelo: modeloCon(60, ['cp-4', 'cp-5']),
        ronda: [
          { tenant_id: TENANT, site_id: SITIO, status: 'completada', compliance_pct: '60.00' },
        ],
      });

      const resultado = await service.despachar(TENANT, PATRULLA);

      expect(mail.enqueue).not.toHaveBeenCalled();
      expect(resultado.omitido).toBe('dominio_no_despachable');
      expect(resultado.suprimidos).toBe(1);
      // Con marca, y con SU motivo: sin marca el barrido volveria a levantar
      // esta ronda cada diez minutos durante 48 h.
      expect(atendidas).toEqual([{ patrolId: PATRULLA, motivo: 'dominio_no_despachable' }]);
    });

    it('no se confunde con "sin destinatarios": son dos arreglos opuestos', async () => {
      const demo = armar({ admins: [ADMIN_DEMO] });
      const vacio = armar({ admins: [] });

      const conDemo = await demo.service.despachar(TENANT, PATRULLA);
      const sinNadie = await vacio.service.despachar(TENANT, PATRULLA);

      expect(conDemo.omitido).toBe('dominio_no_despachable');
      expect(sinNadie.omitido).toBe('sin_destinatarios');
    });

    it('con un admin real y uno de prueba, el real recibe igual', async () => {
      const { service, mail } = armar({
        admins: [ADMIN, ADMIN_DEMO],
        reglas: { reportRecipients: ['qa@demo-andina.test', 'operaciones@cliente.cl'] },
      });

      const resultado = await service.despachar(TENANT, PATRULLA);

      expect(resultado.informes).toBe(2);
      expect(resultado.suprimidos).toBe(2);
      const destinos = mail.enqueue.mock.calls.map(([datos]) => (datos as { to: string }).to);
      expect(destinos).toEqual(['jefa@empresa.cl', 'operaciones@cliente.cl']);
    });

    it('el suprimido NO deja fila en report_deliveries', async () => {
      // La bitacora es de correos DESPACHADOS. Anotar ahi al suprimido diria que
      // se le mando, y ademas lo sacaria del barrido si algun dia se corrige la
      // direccion.
      const { service, manager } = armar({ admins: [ADMIN, ADMIN_DEMO] });

      await service.despachar(TENANT, PATRULLA);

      const insertados = manager.query.mock.calls
        .filter(([sql]) => String(sql).includes('INSERT INTO report_deliveries'))
        .map(([, params]) => String((params as unknown[])[2]));
      expect(insertados).toEqual(['jefa@empresa.cl']);
    });

    it('el log de supresion no lleva ninguna direccion', async () => {
      // CLAUDE.md, regla 5: los logs llevan tenant_id y request_id, no datos de
      // personas. Un correo ES un dato de persona.
      const escritos: string[] = [];
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation((mensaje: unknown) => {
          escritos.push(String(mensaje));
        });

      try {
        const { service } = armar({ admins: [ADMIN, ADMIN_DEMO] });
        await service.despachar(TENANT, PATRULLA);
      } finally {
        warn.mockRestore();
      }

      expect(escritos.length).toBeGreaterThan(0);
      for (const linea of escritos) {
        expect(linea).not.toContain('@');
        expect(linea).toContain(PATRULLA);
      }
    });

    it('con la escotilla de desarrollo abierta, la demo si recibe', async () => {
      // Es el caso de Mailpit en local: captura todo y no manda nada a internet.
      const { service, mail } = armar({
        admins: [ADMIN_DEMO],
        dominios: resolverDominiosNoDespachables({ MAIL_ALLOW_RESERVED_DOMAINS: 'true' }),
      });

      const resultado = await service.despachar(TENANT, PATRULLA);

      expect(resultado.informes).toBe(1);
      expect(resultado.suprimidos).toBe(0);
      expect((mail.enqueue.mock.calls[0]?.[0] as { to: string }).to).toBe(
        'admin@demo-andina.test',
      );
    });
  });

  // -------------------------------------------------------------- consulta

  describe('estadoDeEnvio', () => {
    const ADMIN_SESION = { sub: 'u-admin', role: 'ADMIN' as const };

    it('lista lo entregado y no marca nada como no despachado', async () => {
      const { service } = armar({
        entregas: [{ kind: 'informe', recipient_email: 'jefa@empresa.cl' }],
      });

      const estado = await service.estadoDeEnvio(PATRULLA, ADMIN_SESION);

      expect(estado.deliveries).toHaveLength(1);
      expect(estado.notDispatched).toBeNull();
    });

    it('cuando no se despacho, dice POR QUE', async () => {
      // Sin esto, "lista vacia" no distingue "todavia no se despacho" de "se
      // despacho y se decidio no mandar nada", que es justo lo que llega a
      // soporte como "no me llego el informe".
      const cuando = new Date('2026-08-01T03:00:00.000Z');
      const { service } = armar({
        marcas: [{ reason: 'dominio_no_despachable', attempted_at: cuando }],
      });

      const estado = await service.estadoDeEnvio(PATRULLA, ADMIN_SESION);

      expect(estado.deliveries).toEqual([]);
      expect(estado.notDispatched).toEqual({
        reason: 'dominio_no_despachable',
        attemptedAt: cuando,
      });
    });

    it('el SUPERVISOR sin el recinto asignado no la ve', async () => {
      // El permiso reports:read no alcanza por si solo: el alcance por recinto
      // se verifica aparte (CLAUDE.md, los 4 roles).
      const { service } = armar();

      await expect(
        service.estadoDeEnvio(PATRULLA, { sub: 'u-super', role: 'SUPERVISOR' }),
      ).rejects.toThrow('No tienes este recinto asignado');
    });
  });
});
