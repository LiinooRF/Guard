import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/*
 * `device-signature.ts` importa expo-crypto, que no carga fuera de un telefono.
 * Se revisa el TEXTO, igual que en `native-port.test.ts`: pobre comparado con
 * ejecutar el codigo, y aun asi habria ahorrado el dia que costo este bug.
 *
 * Se quitan los comentarios ANTES de mirar: si no, la prueba encontraria
 * `.buffer` en la explicacion del bug y pasaria siempre.
 */
const FUENTE = readFileSync(
  fileURLToPath(new URL('./device-signature.ts', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('a expo-crypto se le pasa el array tipado, nunca su .buffer', () => {
  /*
   * El bug: pasar `.buffer` calla una queja de TypeScript 6 y rompe la llamada
   * nativa. El modulo de Kotlin no sabe convertir un ArrayBuffer pelado:
   *
   *     Cannot convert '[object ArrayBuffer]' to a Kotlin type.
   *     no ArrayBuffer attached
   *
   * Medido en un moto g35 5G: cada escaneo NFC moria DESPUES de leer la
   * etiqueta, y el guardia veia un error que ni menciona la firma.
   */
  assert.ok(FUENTE.includes('digest('), 'no se encontro ninguna llamada a digest()');
  /*
   * Se mira el archivo ENTERO y no solo dentro del parentesis de `digest(...)`.
   * La primera version de esta prueba hacia justo eso y pasaba con el bug
   * puesto, porque el `.buffer` no estaba en la llamada sino una linea antes,
   * en la variable que se le pasa:
   *
   *     const input = Uint8Array.from(bytes).buffer;
   *     await digest(CryptoDigestAlgorithm.SHA256, input);
   *
   * Este modulo no usa `.buffer` para nada legitimo, asi que prohibirlo entero
   * es exacto y no molesta a nadie. Si algun dia hiciera falta, que sea una
   * decision consciente y no un descuido.
   */
  const linea = FUENTE.split('\n').find((l) => l.includes('.buffer'));
  assert.equal(
    linea,
    undefined,
    `un ArrayBuffer acaba en el modulo nativo y Kotlin no lo acepta: ${linea?.trim()}`,
  );
});
