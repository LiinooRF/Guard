import {
  ANDROID_NO_IDENTIFICADO,
  ERROR_NO_IDENTIFICADO,
  MODELO_NO_IDENTIFICADO,
  VERSION_APP_NO_IDENTIFICADA,
  androidVersionSegura,
  appVersionSegura,
  deviceModelSeguro,
  errorNameSeguro,
  proyectarGruposResumen,
  type CrashReportSummaryRawGroup,
} from './crash-report-summary.projection';

const ADVERSARIALES = [
  'Juan Perez',
  'JuanPerezError',
  'JuanPerez1',
  'JuanPerez123',
  'EMP12345',
  'juan.perez@empresa.cl',
  '\u202eNfcBridgeError',
  '/home/Juan/Pixel8',
  '7c03656d-2c85-4a9c-8f5b-2af93431eca0',
  'Santiago -33.4489,-70.6693',
  '<script>alert(1)</script>',
  'SM-JUAN123',
  'Lenovo EMP-12345',
  'OnePlus Nord JUAN123',
] as const;

function grupo(cambios: Partial<CrashReportSummaryRawGroup> = {}): CrashReportSummaryRawGroup {
  return {
    errorName: 'NfcBridgeError',
    appVersion: '1.4.2',
    deviceModel: 'Redmi 9A',
    androidVersion: '14',
    total: '3',
    fatales: '1',
    ...cambios,
  };
}

describe('proyeccion segura del resumen de caidas', () => {
  it.each(['TypeError', 'NfcBridgeError', 'QueryFailedError', 'java.lang.IllegalStateException'])(
    'conserva el nombre tecnico %s',
    (valor) => {
      expect(errorNameSeguro(valor)).toBe(valor);
    },
  );

  it.each([
    'Redmi 9A',
    'SM-A145M',
    'SM-S901B',
    'Pixel 8 Pro',
    'Pixel Fold',
    'sdk_gphone64_x86_64',
    'moto g power',
    'moto g35 5G',
    'Moto G54',
    'Lenovo TB-X606F',
  ])(
    'conserva el modelo tecnico %s',
    (valor) => {
      expect(deviceModelSeguro(valor)).toBe(valor);
    },
  );

  it.each(['10', '13', '14'])('conserva la version numerica de Android %s', (valor) => {
    expect(androidVersionSegura(valor)).toBe(valor);
  });

  it.each(['0.0.0-e2e', '1.4.2', '2026.08-beta+3'])(
    'conserva la version tecnica de app %s',
    (valor) => {
      expect(appVersionSegura(valor)).toBe(valor);
    },
  );

  it('una etiqueta alfabetica libre no se presenta como version de app', () => {
    expect(appVersionSegura('Juan')).toBe(VERSION_APP_NO_IDENTIFICADA);
  });

  it.each([
    'JuanPerez1',
    '1',
    '1.2',
    '01.2.3',
    '1.2.3.4',
    '2026.13',
    'v1.2.3',
    '1.2.3-JuanPerez',
    '1.2.3-beta.Juan',
    '1.2.3+JuanPerez',
  ])('rechaza la etiqueta sin forma cerrada de release %s', (valor) => {
    expect(appVersionSegura(valor)).toBe(VERSION_APP_NO_IDENTIFICADA);
  });

  it('un nombre con sufijo Error no entra si no esta en el catalogo', () => {
    expect(errorNameSeguro('JuanPerezError')).toBe(ERROR_NO_IDENTIFICADO);
    expect(errorNameSeguro('CustomError')).toBe(ERROR_NO_IDENTIFICADO);
  });

  it('un codigo de dispositivo plausible pero no catalogado cae al fallback', () => {
    expect(deviceModelSeguro('EMP12345')).toBe(MODELO_NO_IDENTIFICADO);
    expect(deviceModelSeguro('SM-JUAN123')).toBe(MODELO_NO_IDENTIFICADO);
    expect(deviceModelSeguro('Pixel 9 Pro')).toBe(MODELO_NO_IDENTIFICADO);
  });

  it.each(ADVERSARIALES)('el errorName libre %s cae en un fallback fijo', (valor) => {
    expect(errorNameSeguro(valor)).toBe(ERROR_NO_IDENTIFICADO);
  });

  it.each(ADVERSARIALES)('el modelo libre %s cae en un fallback fijo', (valor) => {
    expect(deviceModelSeguro(valor)).toBe(MODELO_NO_IDENTIFICADO);
  });

  it.each(ADVERSARIALES)('la version Android libre %s cae en un fallback fijo', (valor) => {
    expect(androidVersionSegura(valor)).toBe(ANDROID_NO_IDENTIFICADO);
  });

  it.each(ADVERSARIALES)('la version de app libre %s no llega a la salida', (valor) => {
    expect(appVersionSegura(valor)).toBe(VERSION_APP_NO_IDENTIFICADA);
  });

  it('acota el nombre de error sin devolver un fragmento del valor rechazado', () => {
    const excedido = `E${'r'.repeat(115)}Error`;

    expect(excedido).toHaveLength(121);
    expect(errorNameSeguro(excedido)).toBe(ERROR_NO_IDENTIFICADO);
  });

  it('fusiona colisiones de sanitizacion y conserva sus conteos', () => {
    const salida = proyectarGruposResumen([
      grupo({
        errorName: 'Juan Perez',
        deviceModel: 'juan.perez@empresa.cl',
        androidVersion: 'Santiago -33.4489,-70.6693',
        total: '7',
        fatales: '2',
      }),
      grupo({
        errorName: '/home/Juan/Error',
        deviceModel: '7c03656d-2c85-4a9c-8f5b-2af93431eca0',
        androidVersion: '\u202e14',
        total: 5,
        fatales: 4,
      }),
    ], 50);

    expect(salida).toEqual([{
      errorName: ERROR_NO_IDENTIFICADO,
      appVersion: '1.4.2',
      deviceModel: MODELO_NO_IDENTIFICADO,
      androidVersion: ANDROID_NO_IDENTIFICADO,
      total: 12,
      fatales: 6,
    }]);

    const serializado = JSON.stringify(salida);
    for (const adversarial of ADVERSARIALES) expect(serializado).not.toContain(adversarial);
  });

  it('ordena despues de fusionar y conserva el limite publico', () => {
    const crudos = Array.from({ length: 55 }, (_, indice) => grupo({
      appVersion: `1.0.0-${indice}`,
      total: String(indice + 1),
      fatales: '0',
    }));

    const salida = proyectarGruposResumen(crudos, 50);

    expect(salida).toHaveLength(50);
    expect(salida[0]).toMatchObject({ appVersion: '1.0.0-54', total: 55 });
    expect(salida.at(-1)).toMatchObject({ appVersion: '1.0.0-5', total: 6 });
  });

  it('la lista cerrada nunca incorpora propiedades crudas adicionales', () => {
    const crudo = {
      ...grupo(),
      fingerprint: '0123456789abcdef',
      errorMessage: 'persona@empresa.cl',
      stack: 'at /home/persona/app.js:1',
      primera: '2026-08-01T10:00:00.000Z',
      ultima: '2026-08-03T22:15:00.000Z',
      id: '7c03656d-2c85-4a9c-8f5b-2af93431eca0',
    };

    const salida = proyectarGruposResumen([crudo], 50);

    expect(Object.keys(salida[0] ?? {}).sort()).toEqual([
      'androidVersion',
      'appVersion',
      'deviceModel',
      'errorName',
      'fatales',
      'total',
    ]);
    expect(JSON.stringify(salida)).not.toContain('persona@empresa.cl');
    expect(JSON.stringify(salida)).not.toContain('0123456789abcdef');
  });
});
