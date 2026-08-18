import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  EVENTO_CONSENTIMIENTO_ACEPTADO,
  reportarPermisoUbicacion,
  traducirEstadoPermiso,
  type DepsReportePermiso,
} from './guard-permiso-ubicacion';

/**
 * El cable de #275: que el portal REPORTE el permiso de ubicacion.
 *
 * El defecto que esto vigila no era un calculo malo sino una ausencia: el
 * endpoint existia, el puente sabia responder, el cliente tenia los metodos, y
 * ninguna linea del portal los usaba. Un guardia nuevo en una empresa nueva
 * quedaba clavado en "el telefono todavia no confirmo el permiso" sin salida.
 * Por eso este spec tiene DOS mitades: la logica (funciones puras) y el
 * CABLEADO (leer el fuente y exigir que alguien llame) — la mitad que faltaba
 * era siempre la segunda.
 */

function deps(sobre: Partial<DepsReportePermiso> = {}): DepsReportePermiso & {
  reportes: Array<{ estado: string; deviceInfo: string }>;
} {
  const reportes: Array<{ estado: string; deviceInfo: string }> = [];
  return {
    consultar: jest.fn().mockResolvedValue({
      permiso: 'ubicacion',
      estado: 'concedido',
      puedeVolverAPedir: true,
    }),
    reportar: jest.fn().mockImplementation((estado: string, deviceInfo: string) => {
      reportes.push({ estado, deviceInfo });
      return Promise.resolve();
    }),
    deviceInfo: 'android api 34 · app 1.2.0',
    reportes,
    ...sobre,
  };
}

describe('traducirEstadoPermiso', () => {
  it.each([
    ['concedido', 'concedido'],
    // Para el servidor los dos denegados son lo mismo: este telefono no entrega
    // ubicacion. La diferencia (si el dialogo puede volver a mostrarse) es de
    // la interfaz, que ofrece Ajustes en vez de un pedido que ya no aparece.
    ['denegado', 'denegado'],
    ['denegado-definitivo', 'denegado'],
    ['no-aplica', 'no_disponible'],
  ] as const)('%s -> %s', (delPuente, delServidor) => {
    expect(traducirEstadoPermiso(delPuente)).toBe(delServidor);
  });
});

describe('reportarPermisoUbicacion', () => {
  it('consulta al puente y reporta el estado con la marca del equipo', async () => {
    const d = deps();

    await expect(reportarPermisoUbicacion(d)).resolves.toEqual({
      hecho: true,
      estado: 'concedido',
    });
    expect(d.reportes).toEqual([
      { estado: 'concedido', deviceInfo: 'android api 34 · app 1.2.0' },
    ]);
  });

  it('el DENEGADO tambien viaja: es dato operativo, no un fallo', async () => {
    // Sin esto, el supervisor ve "sin_reporte" y no distingue al guardia que
    // rechazo el permiso del que nunca abrio la app.
    const d = deps({
      consultar: jest.fn().mockResolvedValue({
        permiso: 'ubicacion',
        estado: 'denegado-definitivo',
        puedeVolverAPedir: false,
      }),
    });

    await expect(reportarPermisoUbicacion(d)).resolves.toEqual({
      hecho: true,
      estado: 'denegado',
    });
  });

  it('sin puente (navegador de escritorio) no reporta y falla BLANDO', async () => {
    const d = deps({
      consultar: jest.fn().mockRejectedValue(new Error('timeout-del-puente')),
    });

    await expect(reportarPermisoUbicacion(d)).resolves.toEqual({
      hecho: false,
      motivo: 'sin-puente',
    });
    expect(d.reportes).toEqual([]);
  });

  it('un reporte rechazado no lanza: la proxima carga reintenta', async () => {
    // Esto corre al montar la pantalla del guardia: una excepcion aca tumbaria
    // la conexion del puente y con ella la ronda entera.
    const d = deps({
      reportar: jest.fn().mockRejectedValue(new Error('HTTP 500')),
    });

    await expect(reportarPermisoUbicacion(d)).resolves.toEqual({
      hecho: false,
      motivo: 'reporte-rechazado',
    });
  });
});

describe('el cableado: que esta vez SI lo llame alguien', () => {
  // La mitad que faltaba en produccion. `git grep 'geo/permission' apps/web`
  // daba CERO llamadas con todas las piezas construidas. Estos tests leen el
  // fuente igual que `mapa-proveedor-montado.spec.ts`: el jest del panel corre
  // sin DOM, y lo que hay que probar es la EXISTENCIA de la conexion, no su
  // renderizado.
  const leer = (nombre: string) => readFileSync(join(__dirname, nombre), 'utf8');

  it('use-guard-bridge consulta y reporta al conectar', () => {
    const fuente = leer('use-guard-bridge.ts');
    expect(fuente).toContain('reportarPermisoUbicacion(');
    expect(fuente).toContain('/geo/permission');
  });

  it('use-guard-bridge escucha la aceptacion del aviso y PIDE el permiso', () => {
    const fuente = leer('use-guard-bridge.ts');
    expect(fuente).toContain('EVENTO_CONSENTIMIENTO_ACEPTADO');
    // pedirPermiso con divulgacionMostrada=true: el dialogo del sistema solo
    // despues de la divulgacion destacada, o Play lo rechaza.
    expect(fuente).toMatch(/pedirPermiso\(\s*'ubicacion',\s*true\s*\)/);
  });

  it('el flujo de consentimiento anuncia la aceptacion', () => {
    const fuente = leer('consentimiento-aviso.tsx');
    expect(fuente).toContain('EVENTO_CONSENTIMIENTO_ACEPTADO');
    expect(fuente).toContain('dispatchEvent');
  });

  it('el nombre del evento tiene el espacio de nombres del producto', () => {
    expect(EVENTO_CONSENTIMIENTO_ACEPTADO).toMatch(/^sentrycore:/);
  });
});

describe('pedir el permiso EN EL INGRESO (bug 10-ago: la app no lo pedia)', () => {
  const fuente = readFileSync(join(__dirname, 'use-guard-bridge.ts'), 'utf8');

  it('al conectar, si no esta concedido y hay consentimiento activo, PIDE el permiso', () => {
    // Antes el `pedirPermiso` (dialogo del sistema) solo se disparaba al ACEPTAR
    // el aviso; un guardia que volvia a entrar con el consentimiento ya vigente
    // no veia ese dialogo nunca y tenia que ir a Ajustes.
    expect(fuente).toContain('consentimientoActivo');
    expect(fuente).toMatch(/pedirPermiso\('ubicacion',\s*true\)/);
  });

  it('el consentimiento activo se verifica contra el servidor (la divulgacion que Play exige)', () => {
    // `consent.granted` en /geo/policy = fila de consentimiento no revocada.
    expect(fuente).toContain("fetch(`${apiUrl}/geo/policy`");
    expect(fuente).toContain('consent?.granted === true');
  });

  it('con el permiso negado EN FIRME muestra el aviso de Ajustes, no un dialogo que no aparece', () => {
    expect(fuente).toContain('avisoUbicacion');
    expect(fuente).toMatch(/puedeVolverAPedir/);
  });

  it('la pantalla del guardia surfacea el aviso de ubicacion', () => {
    for (const pantalla of ['guard-shift.tsx', 'guard-home.tsx']) {
      expect(readFileSync(join(__dirname, pantalla), 'utf8')).toContain('puente.avisoUbicacion');
    }
  });
});
