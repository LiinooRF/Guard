import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { MarcaCorreo, PlantillasMarcaService } from './plantillas-marca';
import { PlantillasRemitenteService } from './plantillas-remitente.service';

/**
 * El unico camino que ESCRIBE tenant_mail_sender (#42).
 *
 * DOS COSAS QUE ESTE ARCHIVO CUIDA Y NINGUN OTRO TEST VE:
 *
 * 1. LA FORMA QUE DEVUELVE EL DRIVER. `INSERT ... ON CONFLICT DO UPDATE ...
 *    RETURNING` llega a Postgres con el command tag `INSERT`, asi que TypeORM
 *    entrega las filas PLANAS. Un `UPDATE` o un `DELETE` sueltos, en cambio,
 *    entregan `[filas, cantidad]`. Por eso los mocks de aca abajo devuelven
 *    `[fila]` y no `[[fila], 1]`: un mock con la forma equivocada deja el test
 *    verde y la respuesta del endpoint en null.
 *
 * 2. QUE LA VERIFICACION DEL DOMINIO NO SE ESCRIBE NI POR ACCIDENTE. Es la
 *    diferencia entre "mi correo sale con el nombre de mi empresa" y "puedo
 *    mandar correo diciendo ser otra empresa". La base lo impide con un grant
 *    por columna y con el trigger, pero el servicio tampoco lo intenta, y eso
 *    se comprueba sobre el SQL que realmente se manda.
 *
 * La consulta contra el esquema real (que las columnas existan) esta en
 * plantillas-remitente.migration.spec.ts: aca se prueba el COMPORTAMIENTO.
 */

const PLATAFORMA = 'VoxIA Control <no-reply@voxiacontrol.cl>';
const VERIFICADA = '2026-07-30T12:00:00.000Z';

function marcaDePrueba(cambios: Partial<MarcaCorreo> = {}): MarcaCorreo {
  return {
    nombreEmpresa: 'Seguridad Andes',
    nombreRemitente: 'Seguridad Andes',
    colorPrimario: '#1f3b73',
    colorTextoSobrePrimario: '#ffffff',
    pie: null,
    logo: null,
    motivoSinLogo: 'sin_logo',
    replyTo: 'contacto@seguridadandes.cl',
    fromAddressVerificada: null,
    esDeLaPlataforma: false,
    ...cambios,
  };
}

/** Una fila de tenant_mail_sender tal cual la entrega el driver: plana. */
function fila(cambios: Record<string, unknown> = {}) {
  return {
    reply_to: 'contacto@seguridadandes.cl',
    from_address: null,
    from_address_verified_at: null,
    ...cambios,
  };
}

interface Llamada {
  sql: string;
  params: unknown[] | undefined;
}

function armar(filas: unknown[], cambiosMarca: Partial<MarcaCorreo> = {}) {
  const llamadas: Llamada[] = [];

  const contexto = {
    get manager() {
      return {
        query: (sql: string, params?: unknown[]) => {
          llamadas.push({ sql, params });
          return Promise.resolve(filas);
        },
      };
    },
  } as unknown as TenantContextService;

  const marca = {
    resolver: () => Promise.resolve(marcaDePrueba(cambiosMarca)),
    remitenteDeLaPlataforma: () => PLATAFORMA,
  } as unknown as PlantillasMarcaService;

  return { servicio: new PlantillasRemitenteService(contexto, marca), llamadas };
}

describe('PlantillasRemitenteService', () => {
  describe('actual', () => {
    it('sin fila configurada no inventa nada y el correo sale desde la plataforma', async () => {
      const { servicio } = armar([], { replyTo: null });

      const remitente = await servicio.actual(200);

      expect(remitente.replyTo).toBeNull();
      expect(remitente.fromAddress).toBeNull();
      expect(remitente.fromAddressVerified).toBe(false);
      expect(remitente.fromAddressVerifiedAt).toBeNull();
      // El nombre visible ya es el de la empresa; la direccion es la del relay.
      expect(remitente.efectivo).toEqual({
        from: '"Seguridad Andes" <no-reply@voxiacontrol.cl>',
        replyTo: null,
      });
    });

    it('consulta la tabla del tenant del contexto y nada mas', async () => {
      const { servicio, llamadas } = armar([fila()]);

      await servicio.actual(200);

      expect(llamadas).toHaveLength(1);
      expect(llamadas[0]?.sql).toContain('FROM tenant_mail_sender');
      // Falla cerrada: sin contexto, app_tenant_id() es NULL y no devuelve nada.
      expect(llamadas[0]?.sql).toContain('WHERE tenant_id = app_tenant_id()');
    });

    it('devuelve el remitente configurado tal cual quedo guardado', async () => {
      const { servicio } = armar([fila({ from_address: 'avisos@seguridadandes.cl' })]);

      const remitente = await servicio.actual(200);

      expect(remitente.replyTo).toBe('contacto@seguridadandes.cl');
      expect(remitente.fromAddress).toBe('avisos@seguridadandes.cl');
      expect(remitente.efectivo.replyTo).toBe('contacto@seguridadandes.cl');
    });
  });

  describe('avisos', () => {
    it('la direccion guardada sin verificar avisa que el correo no sale de ahi', async () => {
      const { servicio } = armar([fila({ from_address: 'avisos@seguridadandes.cl' })]);

      const remitente = await servicio.actual(200);

      expect(remitente.fromAddressVerified).toBe(false);
      expect(remitente.avisos).toHaveLength(1);
      expect(remitente.avisos[0]).toContain('avisos@seguridadandes.cl');
      // El From efectivo sigue siendo el de la plataforma: es justamente lo que
      // el aviso le esta explicando al admin.
      expect(remitente.efectivo.from).toContain('no-reply@voxiacontrol.cl');
    });

    it('la direccion ya verificada no deja aviso y sale en el From', async () => {
      const { servicio } = armar(
        [
          fila({
            from_address: 'avisos@seguridadandes.cl',
            from_address_verified_at: new Date(VERIFICADA),
          }),
        ],
        { fromAddressVerificada: 'avisos@seguridadandes.cl' },
      );

      const remitente = await servicio.actual(200);

      expect(remitente.fromAddressVerified).toBe(true);
      expect(remitente.avisos).toEqual([]);
      expect(remitente.efectivo.from).toBe('"Seguridad Andes" <avisos@seguridadandes.cl>');
    });

    it('sin direccion de respuesta avisa que la respuesta no le llega a la empresa', async () => {
      const { servicio } = armar([fila({ reply_to: null })], { replyTo: null });

      const remitente = await servicio.actual(200);

      expect(remitente.avisos).toHaveLength(1);
      expect(remitente.avisos[0]).toContain('dirección de respuesta');
      expect(remitente.efectivo.replyTo).toBeNull();
    });

    it('sin marca de la empresa avisa que el correo saldria con la de la plataforma', async () => {
      // Pasa de verdad: sin transaccion de tenant, PlantillasMarcaService cae a
      // la plataforma en vez de lanzar.
      const { servicio } = armar([fila()], {
        esDeLaPlataforma: true,
        nombreRemitente: 'VoxIA Control',
        replyTo: null,
      });

      const remitente = await servicio.actual(200);

      expect(remitente.avisos).toHaveLength(2);
      expect(remitente.avisos.join(' ')).toContain('marca de la plataforma');
    });

    it('con todo configurado no hay ningun aviso que mostrar', async () => {
      const { servicio } = armar([fila()]);

      await expect(servicio.actual(200)).resolves.toMatchObject({ avisos: [] });
    });
  });

  describe('fecha de verificacion', () => {
    // El driver puede entregar un timestamptz como Date o como texto segun como
    // este configurado. `.toISOString()` sobre un texto revienta en runtime con
    // el test en verde, y por eso el servicio envuelve el valor en new Date().
    it.each([
      ['un Date', new Date(VERIFICADA)],
      ['un texto', VERIFICADA],
      ['el texto que escribe Postgres', '2026-07-30 12:00:00+00'],
    ])('se normaliza a ISO cuando llega como %s', async (_caso, valor) => {
      const { servicio } = armar([
        fila({
          from_address: 'avisos@seguridadandes.cl',
          from_address_verified_at: valor,
        }),
      ]);

      const remitente = await servicio.actual(200);

      expect(remitente.fromAddressVerified).toBe(true);
      expect(remitente.fromAddressVerifiedAt).toBe(VERIFICADA);
    });
  });

  describe('guardar', () => {
    it('escribe reply_to y from_address, y NUNCA la verificacion', async () => {
      const { servicio, llamadas } = armar([
        fila({ reply_to: 'contacto@seguridadandes.cl', from_address: 'avisos@seguridadandes.cl' }),
      ]);

      await servicio.guardar(
        { replyTo: 'contacto@seguridadandes.cl', fromAddress: 'avisos@seguridadandes.cl' },
        200,
      );

      expect(llamadas).toHaveLength(1);
      const { sql, params } = llamadas[0] ?? { sql: '', params: undefined };
      expect(sql).toContain('INSERT INTO tenant_mail_sender (tenant_id, reply_to, from_address)');
      expect(sql).toContain('VALUES (app_tenant_id(), $1, $2)');
      // Aparece en el RETURNING, pero no se le asigna nada en ningun lado.
      expect(sql).not.toMatch(/from_address_verified_at\s*=/);
      expect(params).toEqual(['contacto@seguridadandes.cl', 'avisos@seguridadandes.cl']);
    });

    it('lee la fila PLANA que devuelve RETURNING, no un [filas, cantidad]', async () => {
      // Si el driver devolviera [filas, cantidad] esta lectura daria null en
      // todo, que es exactamente el bug que se busca no repetir.
      const { servicio } = armar([
        fila({ reply_to: 'contacto@seguridadandes.cl', from_address: 'avisos@seguridadandes.cl' }),
      ]);

      const guardado = await servicio.guardar(
        { replyTo: 'contacto@seguridadandes.cl', fromAddress: 'avisos@seguridadandes.cl' },
        200,
      );

      expect(guardado.replyTo).toBe('contacto@seguridadandes.cl');
      expect(guardado.fromAddress).toBe('avisos@seguridadandes.cl');
    });

    it('guardar en null borra las dos direcciones sin romperse', async () => {
      const { servicio, llamadas } = armar([fila({ reply_to: null })], { replyTo: null });

      const guardado = await servicio.guardar({ replyTo: null, fromAddress: null }, 200);

      expect(llamadas[0]?.params).toEqual([null, null]);
      expect(guardado.replyTo).toBeNull();
      expect(guardado.fromAddress).toBeNull();
      expect(guardado.fromAddressVerified).toBe(false);
    });

    it('si el ON CONFLICT no devolviera fila, responde sin inventar datos', async () => {
      const { servicio } = armar([], { replyTo: null });

      const guardado = await servicio.guardar({ replyTo: null, fromAddress: null }, 200);

      expect(guardado.replyTo).toBeNull();
      expect(guardado.fromAddressVerifiedAt).toBeNull();
      expect(guardado.efectivo.from).toContain('no-reply@voxiacontrol.cl');
    });
  });
});
