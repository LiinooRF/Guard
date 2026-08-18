/**
 * El guardia con la app YA INSTALADA tiene que poder entrar.
 *
 * El renombre a SentryCore cambió la marca del user-agent en la app y en las
 * dos puertas que la miran, todo en el mismo commit. Coherente en el repo e
 * incorrecto en terreno: el APK que el guardia ya tiene en el teléfono sigue
 * diciendo `VoxIAAndroid/`, y al desplegar quedó sin poder entrar —el login lo
 * echaba y el middleware le borraba la sesión— sin nada que pudiera hacer desde
 * el teléfono.
 *
 * Por eso esta prueba fija la marca vieja explícitamente: no es histórico
 * decorativo, es la única forma de que un APK viejo siga funcionando.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MARCAS_APP_GUARDIA,
  PAQUETES_APP_GUARDIA,
  esAppDelGuardia,
  peticionDeAppDelGuardia,
} from './app-del-guardia';

const ANDROID = 'Mozilla/5.0 (Linux; Android 14; moto g35 5G) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36';

describe('esAppDelGuardia', () => {
  it('acepta la app actual', () => {
    expect(esAppDelGuardia(`${ANDROID} SentryCoreAndroid/0.1`)).toBe(true);
  });

  it('acepta la app anterior al renombre, que sigue instalada en los teléfonos', () => {
    expect(esAppDelGuardia(`${ANDROID} VoxIAAndroid/0.1`)).toBe(true);
  });

  it('acepta cualquier versión de la marca, no solo la 0.1', () => {
    expect(esAppDelGuardia(`${ANDROID} SentryCoreAndroid/2.4`)).toBe(true);
    expect(esAppDelGuardia(`${ANDROID} VoxIAAndroid/0.9`)).toBe(true);
  });

  it('rechaza un navegador común: el carril del guardia es la app', () => {
    expect(esAppDelGuardia(ANDROID)).toBe(false);
    expect(esAppDelGuardia('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0.0.0')).toBe(false);
  });

  it('rechaza el user-agent ausente o vacío, en vez de dejar pasar', () => {
    expect(esAppDelGuardia(null)).toBe(false);
    expect(esAppDelGuardia(undefined)).toBe(false);
    expect(esAppDelGuardia('')).toBe(false);
  });

  it('conserva la marca vieja en la lista: quitarla deja gente sin poder trabajar', () => {
    expect(MARCAS_APP_GUARDIA).toContain('VoxIAAndroid/');
    expect(MARCAS_APP_GUARDIA).toContain('SentryCoreAndroid/');
  });
});

describe('las dos puertas del carril del guardia usan la misma comprobación', () => {
  // Una sola de las dos alcanzaba para dejar al guardia afuera, y estaban
  // escritas por separado. Que ambas salgan de aqui es lo que impide que la
  // proxima vez se arregle solo una.
  it.each([
    ['middleware.ts', join(__dirname, '..', '..', 'middleware.ts')],
    ['login-screen.tsx', join(__dirname, '..', '_components', 'login-screen.tsx')],
  ])('%s decide con este modulo y no compara la marca a mano', (_nombre, ruta) => {
    const fuente = readFileSync(ruta, 'utf8');
    // Cualquiera de las dos puertas sirve —el servidor mira ademas el paquete—,
    // lo que no puede es volver a comparar la cadena por su cuenta.
    expect(fuente).toMatch(/(esAppDelGuardia|peticionDeAppDelGuardia)\(/);
    expect(fuente).not.toMatch(/includes\('SentryCoreAndroid\//);
    expect(fuente).not.toMatch(/test\(navigator\.userAgent\)/);
  });
});

describe('peticionDeAppDelGuardia', () => {
  const cabeceras = (mapa: Record<string, string>) => ({
    get: (nombre: string) => mapa[nombre.toLowerCase()] ?? null,
  });

  it('acepta por user-agent, con la marca actual y con la vieja', () => {
    expect(peticionDeAppDelGuardia(cabeceras({ 'user-agent': `${ANDROID} SentryCoreAndroid/0.1` }))).toBe(true);
    expect(peticionDeAppDelGuardia(cabeceras({ 'user-agent': `${ANDROID} VoxIAAndroid/0.1` }))).toBe(true);
  });

  it('acepta por el paquete que pone Android cuando el user-agent llega recortado', () => {
    for (const paquete of PAQUETES_APP_GUARDIA) {
      expect(peticionDeAppDelGuardia(cabeceras({ 'user-agent': ANDROID, 'x-requested-with': paquete }))).toBe(true);
    }
  });

  it('rechaza un navegador comun', () => {
    expect(peticionDeAppDelGuardia(cabeceras({ 'user-agent': ANDROID }))).toBe(false);
    expect(peticionDeAppDelGuardia(cabeceras({}))).toBe(false);
  });

  /*
   * Lo que NO puede abrir la puerta. Una cabecera propia o una cookie las pone
   * cualquiera desde la consola del navegador con una linea; si valieran, el
   * carril del guardia dejaria de ser el de la app. Tampoco vale un paquete que
   * apenas CONTENGA el nombre: `com.otra.sentrycore.falsa` no es la app.
   */
  it('no se abre con una cabecera o cookie que cualquiera puede escribir', () => {
    expect(peticionDeAppDelGuardia(cabeceras({ 'user-agent': ANDROID, 'x-sentrycore-app': '1' }))).toBe(false);
    expect(peticionDeAppDelGuardia(cabeceras({ 'user-agent': ANDROID, cookie: 'sentrycore_native_app=1' }))).toBe(false);
  });

  it('exige el paquete exacto, no que lo contenga', () => {
    expect(peticionDeAppDelGuardia(cabeceras({ 'user-agent': ANDROID, 'x-requested-with': 'com.otra.sentrycore.falsa' }))).toBe(false);
    expect(peticionDeAppDelGuardia(cabeceras({ 'user-agent': ANDROID, 'x-requested-with': 'sentrycore' }))).toBe(false);
  });
});
