import assert from 'node:assert/strict';
import { test } from 'node:test';

import { resolverCamara } from './camara';

test('una consulta de camara que revienta NO tumba el saludo', async () => {
  /*
   * Esto paso en un moto g35 con Android 14, y dejaba al guardia sin poder
   * trabajar: `CameraView.isAvailableAsync()` no existe en Android y lanza
   * `UnavailabilityError`. La excepcion subia hasta `capacidades()`, el shell
   * respondia `error-interno` al `hello` —medido: 38 ms— y el portal se quedaba
   * sin `ready`, con el escaneo deshabilitado por NFC Y por QR.
   */
  const revienta = async (): Promise<boolean> => {
    throw new Error('UnavailabilityError: CameraView.isAvailableAsync no existe en android');
  };
  assert.equal(await resolverCamara(revienta, true), true);
});

test('si se pudo preguntar, manda la respuesta de verdad', async () => {
  assert.equal(await resolverCamara(async () => false, true), false);
  assert.equal(await resolverCamara(async () => true, false), true);
});

test('sin camara y sin poder saberlo, contesta lo que se le diga', async () => {
  const revienta = async (): Promise<boolean> => {
    throw new Error('cualquier cosa');
  };
  assert.equal(await resolverCamara(revienta, false), false);
});
