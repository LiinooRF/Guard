import { normalizarUidDeEtiqueta, normalizarUidNfc, uidNfcValido } from './uid-nfc';

describe('normalización del UID de una etiqueta', () => {
  it('deja el UID igual que la app, venga como venga del lector', () => {
    /*
     * El bug que fija esta prueba: el alta guardaba `input.uid.trim()` y la app
     * manda `id.replace(/[^0-9a-f]/gi, '').toUpperCase()`. Un instalador que
     * pegara el formato con dos puntos —el mas comun— dejaba una etiqueta que
     * NUNCA coincidia al escanear. El alta respondia 201 y el panel la mostraba
     * vinculada: solo se descubria con un guardia parado frente al punto.
     */
    const esperado = '04AABBCCDDEEFF';
    for (const comoLoEscribeElLector of [
      '04:AA:BB:CC:DD:EE:FF',
      '04:aa:bb:cc:dd:ee:ff',
      '04 AA BB CC DD EE FF',
      '04-aa-bb-cc-dd-ee-ff',
      '04aabbccddeeff',
      '  04AABBCCDDEEFF  ',
    ]) {
      expect(normalizarUidDeEtiqueta(comoLoEscribeElLector, 'nfc')).toBe(esperado);
    }
  });

  it('NO toca el UID de un QR: es base32 y quitarle letras lo destruye', () => {
    const qr = 'VXQ-ZE7OSHLBFVJT3CZ3C4KPAPF2Z4';
    expect(normalizarUidDeEtiqueta(qr, 'qr')).toBe(qr);
    // Y se ve por que importa: normalizado como NFC quedaria irreconocible.
    expect(normalizarUidNfc(qr)).not.toBe(qr);
  });

  it('rechaza largos que ningún escaneo podría igualar', () => {
    // Un UID de NFC son 4, 7 o 10 bytes. La app descarta el resto, asi que
    // aceptarlo aqui crearia una fila muerta.
    expect(uidNfcValido('04AABBCC')).toBe(true);
    expect(uidNfcValido('04AABBCCDDEEFF')).toBe(true);
    expect(uidNfcValido('04AA')).toBe(false);
    expect(uidNfcValido('04AABBC')).toBe(false);
    expect(uidNfcValido('')).toBe(false);
  });

  it('un UID que solo trae separadores no pasa por válido', () => {
    expect(normalizarUidDeEtiqueta('::::', 'nfc')).toBe('');
    expect(uidNfcValido(normalizarUidDeEtiqueta('::::', 'nfc'))).toBe(false);
  });
});
