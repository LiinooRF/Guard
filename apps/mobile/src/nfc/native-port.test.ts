import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/*
 * `native-port.ts` importa `react-native` y `react-native-nfc-manager`, que no
 * cargan fuera de un telefono: no se puede importar aqui. Se revisa el TEXTO del
 * archivo, igual que `migrations.spec.ts` revisa el de las migraciones.
 *
 * Es una prueba pobre comparada con ejecutar el codigo, y aun asi habria
 * ahorrado el dia entero que costo este bug.
 */
const TEXTO = readFileSync(
  fileURLToPath(new URL('./native-port.ts', import.meta.url)),
  'utf8',
);

/*
 * Se quitan los comentarios ANTES de mirar nada. La primera version de esta
 * prueba buscaba `readerModeFlags` en el archivo entero y pasaba aunque se
 * borrara del codigo: la palabra seguia estando en el comentario que explica el
 * bug. Pasaba con y sin el arreglo, o sea que no probaba nada.
 */
const FUENTE = TEXTO.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

test('el modo lector NUNCA se enciende sin decir que familias escucha', () => {
  /*
   * El bug que fija esta prueba: `requestTechnology(..., { isReaderModeEnabled:
   * true })` deja `readerModeFlags` en 0 por defecto. Con cero banderas el modo
   * lector se enciende sin escuchar NADA — la etiqueta nunca llega a la app y
   * Android abre su visor de etiquetas encima de la ronda. Falla en silencio:
   * ni excepcion, ni error, ni un solo mensaje. Medido en un moto g35 5G.
   */
  const enciendeModoLector = FUENTE.includes('isReaderModeEnabled: true');
  if (!enciendeModoLector) return;
  assert.ok(
    FUENTE.includes('readerModeFlags'),
    'se enciende el modo lector sin readerModeFlags: Android no escuchara ninguna etiqueta',
  );
});

test('escucha las cuatro familias de etiquetas, no solo NfcA', () => {
  /*
   * Las etiquetas de un recinto las compra el cliente. Un lote ISO 15693
   * (NfcV) es comun en control de accesos y, con solo NfcA, el guardia no
   * podria marcar ningun punto sin que nadie supiera por que.
   */
  for (const familia of ['FLAG_READER_NFC_A', 'FLAG_READER_NFC_B',
    'FLAG_READER_NFC_F', 'FLAG_READER_NFC_V']) {
    assert.ok(FUENTE.includes(familia), `falta ${familia} entre las familias que escucha`);
  }
});
