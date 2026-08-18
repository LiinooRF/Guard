import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  ANDROID_NO_IDENTIFICADO,
  DEVICE_MODELS_PERMITIDOS,
  ERROR_NAMES_PERMITIDOS,
  ERROR_NO_IDENTIFICADO,
  MODELO_NO_IDENTIFICADO,
  PATRON_VERSION_ANDROID,
  PATRON_VERSION_APP,
  VERSION_APP_NO_IDENTIFICADA,
  cargarResumenCrashes,
  CrashReportsSummaryView,
  type EstadoVistaResumenCrash,
} from './crash-reports-summary';
import {
  ANDROID_NO_IDENTIFICADO as ANDROID_NO_IDENTIFICADO_API,
  DEVICE_MODELS_PERMITIDOS as DEVICE_MODELS_PERMITIDOS_API,
  ERROR_NAMES_PERMITIDOS as ERROR_NAMES_PERMITIDOS_API,
  ERROR_NO_IDENTIFICADO as ERROR_NO_IDENTIFICADO_API,
  MODELO_NO_IDENTIFICADO as MODELO_NO_IDENTIFICADO_API,
  PATRON_VERSION_ANDROID as PATRON_VERSION_ANDROID_API,
  PATRON_VERSION_APP as PATRON_VERSION_APP_API,
  VERSION_APP_NO_IDENTIFICADA as VERSION_APP_NO_IDENTIFICADA_API,
} from '../../../api/src/observability/crash-report-summary.projection';

function respuesta(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function resumenValido(extra: Record<string, unknown> = {}) {
  return {
    ventanaDias: 30,
    grupos: [{
      errorName: 'NfcBridgeError',
      appVersion: '1.4.2',
      deviceModel: 'Redmi 9A',
      androidVersion: '14',
      total: 13,
      fatales: 2,
      ...extra,
    }],
  };
}

type CampoTecnico = 'errorName' | 'appVersion' | 'deviceModel' | 'androidVersion';

const RESPALDO_POR_CAMPO: Record<CampoTecnico, string> = {
  errorName: 'Error no identificado',
  appVersion: 'Versión de app no identificada',
  deviceModel: 'Modelo no identificado',
  androidVersion: 'Versión no identificada',
};

const VALORES_NO_TECNICOS = [
  ['nombre corto', 'Juan'],
  ['nombre', 'Juan Perez'],
  ['nombre sin espacios', 'JuanPerez'],
  ['nombre con sufijo de error', 'JuanPerezError'],
  ['nombre con un dígito', 'JuanPerez1'],
  ['nombre con varios dígitos', 'JuanPerez123'],
  ['identificador de empleado', 'EMP12345'],
  ['nombre envuelto en modelo Pixel', 'Pixel 8 Pro JuanPerez123'],
  ['nombre envuelto en modelo Redmi', 'Redmi 9A JuanPerez123'],
  ['identificador envuelto en modelo Lenovo', 'Lenovo TB-X606F EMP12345'],
  ['identificador envuelto en modelo Samsung', 'SM-S901B EMP12345'],
  ['nombre envuelto en prefijo Samsung', 'SM-JUAN123'],
  ['identificador envuelto en marca Lenovo', 'Lenovo EMP-12345'],
  ['nombre envuelto en familia OnePlus', 'OnePlus Nord JUAN123'],
  ['correo', 'persona@empresa.cl'],
  ['control bidi', '\u202eNfcBridgeError'],
  ['ruta con slash', '/home/Juan/Pixel8'],
  ['markup', '<script>alert(1)</script>'],
  ['UUID', '7c03656d-2c85-4a9c-8f5b-2af93431eca0'],
  ['ubicación', 'Santiago -33.4489,-70.6693'],
  ['texto libre', 'Telefono de prueba'],
] as const;

const BORDES_REABIERTOS = [
  ['errorName', 'JuanPerezError'],
  ['appVersion', 'JuanPerez1'],
  ['deviceModel', 'JuanPerez123'],
  ['deviceModel', 'EMP12345'],
  ['deviceModel', 'SM-JUAN123'],
  ['deviceModel', 'Lenovo EMP-12345'],
  ['deviceModel', 'OnePlus Nord JUAN123'],
] as const satisfies ReadonlyArray<readonly [CampoTecnico, string]>;

describe('carga segura del resumen de fallas (#225)', () => {
  it('mantiene byte a byte el contrato técnico sincronizado con la API', () => {
    expect(ERROR_NAMES_PERMITIDOS).toEqual(ERROR_NAMES_PERMITIDOS_API);
    expect(DEVICE_MODELS_PERMITIDOS).toEqual(DEVICE_MODELS_PERMITIDOS_API);
    expect(PATRON_VERSION_APP.source).toBe(PATRON_VERSION_APP_API.source);
    expect(PATRON_VERSION_APP.flags).toBe(PATRON_VERSION_APP_API.flags);
    expect(PATRON_VERSION_ANDROID.source).toBe(PATRON_VERSION_ANDROID_API.source);
    expect(PATRON_VERSION_ANDROID.flags).toBe(PATRON_VERSION_ANDROID_API.flags);
    expect([
      ERROR_NO_IDENTIFICADO,
      VERSION_APP_NO_IDENTIFICADA,
      MODELO_NO_IDENTIFICADO,
      ANDROID_NO_IDENTIFICADO,
    ]).toEqual([
      ERROR_NO_IDENTIFICADO_API,
      VERSION_APP_NO_IDENTIFICADA_API,
      MODELO_NO_IDENTIFICADO_API,
      ANDROID_NO_IDENTIFICADO_API,
    ]);
  });

  it('usa el contrato real /summary con cookie HttpOnly y cabecera JSON', async () => {
    const pedir = jest.fn(async () => respuesta(200, resumenValido()));

    await cargarResumenCrashes('/api', pedir);

    expect(pedir).toHaveBeenCalledTimes(1);
    expect(pedir).toHaveBeenCalledWith('/api/observability/crash-reports/summary', {
      cache: 'no-store',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
  });

  it('proyecta solo tipo, versión, modelo y conteos', async () => {
    const resultado = await cargarResumenCrashes('/api', async () => respuesta(200, resumenValido({
      huella: '2f52ab71854f9d01',
      errorMessage: 'correo persona@empresa.cl en /home/persona',
      stack: 'at secreto (/home/persona/app.js:1)',
      primera: '2026-08-01T10:00:00.000Z',
      id: '7c03656d-2c85-4a9c-8f5b-2af93431eca0',
      guardName: 'Persona de prueba',
      latitude: -33.44,
    })));

    expect(resultado).toEqual({
      estado: 'listo',
      ventanaDias: 30,
      grupos: [{
        errorName: 'NfcBridgeError',
        appVersion: '1.4.2',
        deviceModel: 'Redmi 9A',
        androidVersion: '14',
        total: 13,
        fatales: 2,
      }],
    });

    const serializado = JSON.stringify(resultado);
    for (const prohibido of [
      'huella',
      'errorMessage',
      'stack',
      'primera',
      'guardName',
      'latitude',
      'persona@empresa.cl',
      '7c03656d-2c85-4a9c-8f5b-2af93431eca0',
    ]) {
      expect(serializado).not.toContain(prohibido);
    }
  });

  it.each(['CustomError', 'Exception', 'java.lang.RuntimeException'])(
    'sustituye la clase no observada %s aunque tenga forma de error',
    async (errorName) => {
      const resultado = await cargarResumenCrashes('/api', async () => respuesta(
        200,
        resumenValido({ errorName }),
      ));

      expect(resultado).toMatchObject({
        estado: 'listo',
        grupos: [{ errorName: 'Error no identificado' }],
      });
    },
  );

  it.each([
    ['errorName', 'Error'],
    ['errorName', 'TypeError'],
    ['errorName', 'NfcBridgeError'],
    ['errorName', 'QueryFailedError'],
    ['errorName', 'java.lang.IllegalStateException'],
    ['appVersion', '0.0.0-e2e'],
    ['appVersion', '0.1.0'],
    ['appVersion', '1.4.2'],
    ['appVersion', '2026.08-beta+3'],
    ['deviceModel', 'Redmi 9A'],
    ['deviceModel', 'SM-A145M'],
    ['deviceModel', 'SM-S901B'],
    ['deviceModel', 'Pixel 8 Pro'],
    ['deviceModel', 'sdk_gphone64_x86_64'],
    ['deviceModel', 'Pixel Fold'],
    ['deviceModel', 'moto g power'],
    ['deviceModel', 'moto g35 5G'],
    ['deviceModel', 'Moto G54'],
    ['deviceModel', 'Lenovo TB-X606F'],
    ['androidVersion', '4.4.4'],
    ['androidVersion', '10'],
    ['androidVersion', '14'],
    ['androidVersion', '35'],
  ] as Array<[CampoTecnico, string]>)('conserva el valor técnico %s=%s', async (campo, valor) => {
    const resultado = await cargarResumenCrashes('/api', async () => respuesta(
      200,
      resumenValido({ [campo]: valor }),
    ));

    expect(resultado).toMatchObject({ estado: 'listo', grupos: [{ [campo]: valor }] });
  });

  it('canonicaliza solo el espacio exterior de un modelo permitido', async () => {
    const resultado = await cargarResumenCrashes('/api', async () => respuesta(
      200,
      resumenValido({ deviceModel: '  Redmi 9A  ' }),
    ));

    expect(resultado).toMatchObject({
      estado: 'listo',
      grupos: [{ deviceModel: 'Redmi 9A' }],
    });
  });

  it.each(['POCO X6 Pro', 'CPH2451', 'Nokia 7.2', 'SM-G991B', 'Pixel 9 Pro'])(
    'sustituye el modelo real %s mientras no esté en el catálogo finito',
    async (deviceModel) => {
      const resultado = await cargarResumenCrashes('/api', async () => respuesta(
        200,
        resumenValido({ deviceModel }),
      ));

      expect(resultado).toMatchObject({
        estado: 'listo',
        grupos: [{ deviceModel: 'Modelo no identificado' }],
      });
    },
  );

  it.each(BORDES_REABIERTOS)(
    'cierra el borde reabierto %s=%s con un fallback fijo',
    async (campo, valor) => {
      const resultado = await cargarResumenCrashes('/api', async () => respuesta(
        200,
        resumenValido({ [campo]: valor }),
      ));

      expect(resultado).toMatchObject({
        estado: 'listo',
        grupos: [{ [campo]: RESPALDO_POR_CAMPO[campo] }],
      });
      expect(JSON.stringify(resultado)).not.toContain(valor);
    },
  );

  for (const campo of Object.keys(RESPALDO_POR_CAMPO) as CampoTecnico[]) {
    it.each(VALORES_NO_TECNICOS)(
      `sustituye ${campo} no técnico (%s) sin conservar el valor`,
      async (_caso, valor) => {
        const resultado = await cargarResumenCrashes('/api', async () => respuesta(
          200,
          resumenValido({ [campo]: valor }),
        ));

        expect(resultado).toMatchObject({
          estado: 'listo',
          grupos: [{ [campo]: RESPALDO_POR_CAMPO[campo] }],
        });
        expect(JSON.stringify(resultado)).not.toContain(valor);
      },
    );
  }

  it.each([
    '1',
    '1.2',
    '01.2.3',
    '1.2.3.4',
    '2026.13',
    'v1.2.3',
    '1.2.3-JuanPerez',
    '1.2.3-beta.Juan',
    '1.2.3+JuanPerez',
  ])(
    'sustituye el identificador sin forma real de versión %s',
    async (appVersion) => {
      const resultado = await cargarResumenCrashes('/api', async () => respuesta(
        200,
        resumenValido({ appVersion }),
      ));

      expect(resultado).toMatchObject({
        estado: 'listo',
        grupos: [{ appVersion: 'Versión de app no identificada' }],
      });
    },
  );

  it.each(['0', '01', '100', '14-beta', '4.4.4.1', '14/15'])(
    'sustituye la versión Android fuera de forma %s',
    async (androidVersion) => {
      const resultado = await cargarResumenCrashes('/api', async () => respuesta(
        200,
        resumenValido({ androidVersion }),
      ));

      expect(resultado).toMatchObject({
        estado: 'listo',
        grupos: [{ androidVersion: 'Versión no identificada' }],
      });
    },
  );

  it.each([
    { ventanaDias: 0, grupos: [] },
    { ventanaDias: 366, grupos: [] },
    { ventanaDias: 30, grupos: [{ appVersion: '1.0.0' }] },
    resumenValido({ errorName: null }),
    resumenValido({ appVersion: 14 }),
    resumenValido({ deviceModel: null }),
    resumenValido({ androidVersion: 14 }),
    resumenValido({ total: 0 }),
    resumenValido({ total: 2, fatales: 3 }),
  ])('falla cerrado ante un agregado inválido %#', async (body) => {
    await expect(
      cargarResumenCrashes('/api', async () => respuesta(200, body)),
    ).resolves.toEqual({ estado: 'error' });
  });

  it('rechaza más grupos que el tope de presentación de la API', async () => {
    const grupo = resumenValido().grupos[0];
    await expect(
      cargarResumenCrashes('/api', async () => respuesta(200, {
        ventanaDias: 30,
        grupos: Array.from({ length: 51 }, () => grupo),
      })),
    ).resolves.toEqual({ estado: 'error' });
  });

  it('distingue módulo apagado y licencia ausente después del 404', async () => {
    const apagado = jest.fn()
      .mockResolvedValueOnce(respuesta(404, {}))
      .mockResolvedValueOnce(respuesta(200, {
        enabled: { crashReporting: false },
        entitlements: { crashReporting: true },
      }));
    const noIncluido = jest.fn()
      .mockResolvedValueOnce(respuesta(404, {}))
      .mockResolvedValueOnce(respuesta(200, {
        enabled: { crashReporting: false },
        entitlements: { crashReporting: false },
      }));

    await expect(cargarResumenCrashes('/api', apagado)).resolves.toEqual({ estado: 'apagado' });
    await expect(cargarResumenCrashes('/api', noIncluido)).resolves.toEqual({ estado: 'no-incluido' });
    expect(apagado).toHaveBeenNthCalledWith(2, '/api/features/admin', {
      cache: 'no-store',
      credentials: 'include',
      headers: { accept: 'application/json' },
    });
  });

  it('no afirma que está apagado si no puede leer la licencia', async () => {
    const pedir = jest.fn()
      .mockResolvedValueOnce(respuesta(404, {}))
      .mockResolvedValueOnce(respuesta(503, {}));

    await expect(cargarResumenCrashes('/api', pedir)).resolves.toEqual({
      estado: 'apagado-desconocido',
    });
  });

  it('trata como error la contradicción 404 + módulo declarado activo', async () => {
    const activo = jest.fn()
      .mockResolvedValueOnce(respuesta(404, {}))
      .mockResolvedValueOnce(respuesta(200, {
        enabled: { crashReporting: true },
        entitlements: { crashReporting: true },
      }));
    const fueraDelPlanPeroActivo = jest.fn()
      .mockResolvedValueOnce(respuesta(404, {}))
      .mockResolvedValueOnce(respuesta(200, {
        enabled: { crashReporting: true },
        entitlements: { crashReporting: false },
      }));

    await expect(cargarResumenCrashes('/api', activo)).resolves.toEqual({ estado: 'error' });
    await expect(cargarResumenCrashes('/api', fueraDelPlanPeroActivo)).resolves.toEqual({
      estado: 'error',
    });
  });

  it('separa un error HTTP o JSON inválido del estado vacío', async () => {
    await expect(
      cargarResumenCrashes('/api', async () => respuesta(503, {})),
    ).resolves.toEqual({ estado: 'error' });
    await expect(
      cargarResumenCrashes('/api', async () => ({
        ok: true,
        status: 200,
        json: async () => { throw new Error('JSON inválido'); },
      })),
    ).resolves.toEqual({ estado: 'error' });
    await expect(
      cargarResumenCrashes('/api', async () => respuesta(200, { ventanaDias: 30, grupos: [] })),
    ).resolves.toEqual({ estado: 'listo', ventanaDias: 30, grupos: [] });
  });
});

describe('vista ADMIN del resumen de fallas (#225)', () => {
  it.each([
    [{ estado: 'cargando' }, ['aria-busy="true"', 'role="status"', 'Cargando el diagnóstico agregado']],
    [{ estado: 'error' }, ['role="alert"', 'No se muestran datos parciales', 'Reintentar']],
    [{ estado: 'listo', ventanaDias: 30, grupos: [] }, ['No hay fallas registradas']],
  ] as Array<[EstadoVistaResumenCrash, string[]]>)('renderiza el estado %s', (estado, textos) => {
    const html = renderToStaticMarkup(
      createElement(CrashReportsSummaryView, { estado, onRetry: jest.fn() }),
    );
    for (const texto of textos) expect(html).toContain(texto);
  });

  it('da instrucciones accionables solo cuando la licencia permite activar', () => {
    const apagado = render({ estado: 'apagado' });
    const noIncluido = render({ estado: 'no-incluido' });
    const desconocido = render({ estado: 'apagado-desconocido' });

    expect(apagado).toContain('href="?vista=reglas#funciones"');
    expect(apagado).toContain('activa «Reporte de fallas de la app»');
    expect(apagado).toContain('Guardar módulos');

    expect(noIncluido).toContain('Módulo no incluido');
    expect(noIncluido).toContain('solicita un cambio de plan');
    expect(noIncluido).not.toContain('puedes activarlo');
    expect(noIncluido).not.toContain('href=');

    expect(desconocido).toContain('No pudimos confirmar');
    expect(desconocido).toContain('href="?vista=reglas#funciones"');
    expect(desconocido).toContain('Reintentar');
  });

  it('muestra repetición, versión y modelo con tabla accesible', () => {
    const html = render({
      estado: 'listo',
      ventanaDias: 30,
      grupos: [{
        errorName: 'NfcBridgeError',
        appVersion: '1.4.2',
        deviceModel: 'Redmi 9A',
        androidVersion: '14',
        total: 13,
        fatales: 2,
      }],
    });

    expect(html).toContain('role="region"');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('<caption>');
    expect(html).toContain('Tipo de falla');
    expect(html).toContain('<code>NfcBridgeError</code>');
    expect(html).toContain('Versión de app');
    expect(html).toContain('1.4.2');
    expect(html).toContain('Modelo');
    expect(html).toContain('Redmi 9A');
    expect(html).toContain('<strong>13</strong> fallas agregadas');
    expect(html).not.toContain('errorMessage');
    expect(html).not.toContain('huella');
  });

  it('satura los totales agregados antes de perder precisión numérica', () => {
    const grupo = {
      errorName: 'TypeError',
      appVersion: '1.4.2',
      deviceModel: 'Redmi 9A',
      androidVersion: '14',
    };
    const html = render({
      estado: 'listo',
      ventanaDias: 30,
      grupos: [
        { ...grupo, total: Number.MAX_SAFE_INTEGER, fatales: Number.MAX_SAFE_INTEGER },
        { ...grupo, total: 2, fatales: 2 },
      ],
    });

    expect(html).toContain(
      'aria-label="9007199254740991 fallas, 9007199254740991 fatales"',
    );
    expect(html).not.toContain('9007199254740992 fallas');
  });

  it('monta diagnóstico y configuración del módulo solo en ramas ADMIN', () => {
    const pagina = readFileSync(join(__dirname, '..', 'app', '[role]', 'page.tsx'), 'utf8');

    expect(pagina).toContain("else if (!isSupervisor && view === 'diagnostico')");
    expect(pagina).toContain('<CrashReportsSummary apiUrl={publicApiUrl()} />');
    expect(pagina).toContain("else if (!isSupervisor && view === 'reglas')");
    expect(pagina).toContain('<FuncionesConfiguracion apiUrl={publicApiUrl()} />');
    expect(pagina).toContain('<ReglasConfiguracion apiUrl={publicApiUrl()} />');
    expect(pagina.indexOf('<FuncionesConfiguracion')).toBeLessThan(
      pagina.indexOf('<ReglasConfiguracion'),
    );
  });

  it('acota el ancho al panel y deja el desplazamiento solo en la tabla', () => {
    const css = readFileSync(join(__dirname, '..', 'globals.css'), 'utf8');

    expect(css).toMatch(/\.crash-summary \{[^}]*min-width: 0;/);
    expect(css).toMatch(/\.crash-table-wrap \{[^}]*max-width: 100%;[^}]*overflow-x: auto;/);
    expect(css).toMatch(/\.crash-table-wrap:focus-visible \{[^}]*outline: 3px solid #0b57d0;/);
  });
});

function render(estado: EstadoVistaResumenCrash): string {
  return renderToStaticMarkup(
    createElement(CrashReportsSummaryView, { estado, onRetry: jest.fn() }),
  );
}
