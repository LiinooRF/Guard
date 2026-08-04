import { patrolRulesSchema, type PatrolRules } from '@voxia/shared';
import type { Queue } from 'bullmq';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { MailQueueService } from '../mail/mail-queue.service';
import type { RulesService } from '../rules/rules.service';
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
  reglas?: Partial<PatrolRules>;
  modelo?: InformeRonda;
  /** Bytes que "pesa" el PDF dibujado. */
  pesoPdf?: number;
}

const ADMIN = { id: 'u-admin', email: 'Jefa@Empresa.cl' };

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
});
