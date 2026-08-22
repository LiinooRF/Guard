/**
 * El código de empresa se guarda para que el guardia NO lo escriba de nuevo.
 *
 * Estas pruebas fijan las tres cosas que lo hacen usable en una garita: que un
 * código escrito con el teclado del teléfono (mayúscula inicial, un espacio de
 * más) se acepte igual, que un almacenamiento que falla degrade a "escribilo"
 * en vez de tumbar la pantalla de ingreso, y que sin `window` —el render del
 * servidor de Next— no explote.
 *
 * El doble de `localStorage` es a mano y no jsdom: este paquete corre sus
 * pruebas en `node` a propósito (ver `jest.config.js`) y un entorno de
 * navegador entero para probar tres claves no se paga solo.
 */

import {
  esCodigoEmpresaValido,
  guardarCodigoEmpresa,
  leerCodigoEmpresa,
  normalizarCodigoEmpresa,
  olvidarCodigoEmpresa,
} from './codigo-empresa';

const CLAVE = 'sentrycore.codigo-empresa';

function almacenamientoFalso() {
  const datos = new Map<string, string>();
  return {
    getItem: (clave: string) => datos.get(clave) ?? null,
    setItem: (clave: string, valor: string) => void datos.set(clave, valor),
    removeItem: (clave: string) => void datos.delete(clave),
  };
}

function montarNavegador(localStorage: unknown) {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { localStorage },
    writable: true,
  });
}

describe('código de empresa fijado en el teléfono', () => {
  beforeEach(() => montarNavegador(almacenamientoFalso()));
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('sobrevive al cierre: lo que se guarda es lo que se lee', () => {
    guardarCodigoEmpresa('seguridad-andina');
    expect(leerCodigoEmpresa()).toBe('seguridad-andina');
  });

  it('acepta lo que sale del teclado del teléfono', () => {
    guardarCodigoEmpresa('  Seguridad-Andina  ');
    expect(leerCodigoEmpresa()).toBe('seguridad-andina');
    expect(normalizarCodigoEmpresa(' ANDINA ')).toBe('andina');
  });

  it('no guarda basura que la API va a rechazar igual', () => {
    guardarCodigoEmpresa('con espacios');
    guardarCodigoEmpresa('ab');
    guardarCodigoEmpresa('acento-ñ');
    expect(leerCodigoEmpresa()).toBe('');
    expect(esCodigoEmpresaValido('con espacios')).toBe(false);
    expect(esCodigoEmpresaValido('empresa-a')).toBe(true);
  });

  it('un valor corrupto en el almacenamiento se ignora, no se manda a la API', () => {
    window.localStorage.setItem(CLAVE, 'esto no es un slug');
    expect(leerCodigoEmpresa()).toBe('');
  });

  it('olvidar deja el teléfono como recién instalado', () => {
    guardarCodigoEmpresa('andina');
    olvidarCodigoEmpresa();
    expect(leerCodigoEmpresa()).toBe('');
  });

  /*
   * Con el almacenamiento bloqueado —modo privado, política del dispositivo— el
   * guardia tiene que poder escribir el código y entrar. Perder el "recordarlo"
   * es aceptable; perder el ingreso no.
   */
  it('si el almacenamiento falla, se entra igual sin código guardado', () => {
    montarNavegador({
      getItem() {
        throw new Error('almacenamiento bloqueado');
      },
      setItem() {
        throw new Error('almacenamiento bloqueado');
      },
      removeItem() {
        throw new Error('almacenamiento bloqueado');
      },
    });

    expect(() => guardarCodigoEmpresa('andina')).not.toThrow();
    expect(leerCodigoEmpresa()).toBe('');
    expect(() => olvidarCodigoEmpresa()).not.toThrow();
  });

  it('valida límites de longitud de 3 a 48 caracteres', () => {
    expect(esCodigoEmpresaValido('abc')).toBe(true);
    expect(esCodigoEmpresaValido('ab')).toBe(false);
    const largo48 = 'a'.repeat(48);
    const largo49 = 'a'.repeat(49);
    expect(esCodigoEmpresaValido(largo48)).toBe(true);
    expect(esCodigoEmpresaValido(largo49)).toBe(false);
  });

  it('valida reglas de guiones en el slug', () => {
    expect(esCodigoEmpresaValido('mi-empresa-123')).toBe(true);
    expect(esCodigoEmpresaValido('-empresa')).toBe(false);
    expect(esCodigoEmpresaValido('empresa-')).toBe(false);
    expect(esCodigoEmpresaValido('empresa--andina')).toBe(false);
    expect(esCodigoEmpresaValido('empresa_andina')).toBe(false);
    expect(esCodigoEmpresaValido('empresa.cl')).toBe(false);
  });

  it('normaliza mayúsculas y espacios antes de validar y guardar', () => {
    guardarCodigoEmpresa('   Empresa-Norte-99   ');
    expect(leerCodigoEmpresa()).toBe('empresa-norte-99');
  });

  it('en el render del servidor, sin window, tampoco explota', () => {
    delete (globalThis as { window?: unknown }).window;
    expect(leerCodigoEmpresa()).toBe('');
    expect(() => guardarCodigoEmpresa('andina')).not.toThrow();
  });
});
