import { WEBHOOK_VENTANA_SEGUNDOS } from './registro-envios.constants';
import { cadenaCanonica, firmar, verificarFirma } from './registro-envios.firma';

const SECRETO = 'secreto-de-pruebas-que-no-esta-en-ningun-entorno';
const MESSAGE_ID = 'abc123@voxia.example';
const AHORA_SEG = 1_756_000_000;
const AHORA_MS = AHORA_SEG * 1000;

function peticion(overrides: Partial<Parameters<typeof verificarFirma>[1]> = {}) {
  const base = {
    messageId: MESSAGE_ID,
    evento: 'entregado',
    timestamp: AHORA_SEG,
  };
  const conOverrides = { ...base, ...overrides };
  return {
    ...conOverrides,
    firma:
      overrides.firma ??
      firmar(SECRETO, conOverrides.messageId, conOverrides.evento, conOverrides.timestamp),
  };
}

describe('firma del webhook de estado de entrega', () => {
  it('acepta una peticion firmada y fresca', () => {
    expect(verificarFirma(SECRETO, peticion(), AHORA_MS)).toEqual({ valido: true });
  });

  it('falla cerrada cuando no hay secreto configurado', () => {
    expect(verificarFirma(undefined, peticion(), AHORA_MS)).toEqual({
      valido: false,
      motivo: 'sin_secreto',
    });
    expect(verificarFirma('   ', peticion(), AHORA_MS)).toEqual({
      valido: false,
      motivo: 'sin_secreto',
    });
  });

  it('rechaza una firma de otro secreto', () => {
    const ajena = {
      ...peticion(),
      firma: firmar('otro-secreto-distinto', MESSAGE_ID, 'entregado', AHORA_SEG),
    };
    expect(verificarFirma(SECRETO, ajena, AHORA_MS)).toEqual({
      valido: false,
      motivo: 'invalida',
    });
  });

  it('rechaza si cambia cualquiera de los tres campos firmados', () => {
    const original = peticion();

    for (const alterada of [
      { ...original, messageId: 'otro@voxia.example' },
      { ...original, evento: 'rebotado' },
      { ...original, timestamp: AHORA_SEG - 1 },
    ]) {
      expect(verificarFirma(SECRETO, alterada, AHORA_MS)).toEqual({
        valido: false,
        motivo: 'invalida',
      });
    }
  });

  it('rechaza una peticion vieja aunque la firma calce', () => {
    const vieja = peticion({ timestamp: AHORA_SEG - WEBHOOK_VENTANA_SEGUNDOS - 1 });
    expect(verificarFirma(SECRETO, vieja, AHORA_MS)).toEqual({
      valido: false,
      motivo: 'vencida',
    });
  });

  it('rechaza tambien una peticion del futuro: el desfase se mide en valor absoluto', () => {
    const futura = peticion({ timestamp: AHORA_SEG + WEBHOOK_VENTANA_SEGUNDOS + 1 });
    expect(verificarFirma(SECRETO, futura, AHORA_MS)).toEqual({
      valido: false,
      motivo: 'vencida',
    });
  });

  it('no revienta con una firma de largo distinto (timingSafeEqual lanza si no calzan)', () => {
    expect(() =>
      verificarFirma(SECRETO, { ...peticion(), firma: 'corta' }, AHORA_MS),
    ).not.toThrow();
    expect(verificarFirma(SECRETO, { ...peticion(), firma: 'corta' }, AHORA_MS)).toEqual({
      valido: false,
      motivo: 'invalida',
    });
  });

  it('publica la cadena canonica para que el traductor firme lo mismo', () => {
    expect(cadenaCanonica(MESSAGE_ID, 'rebotado', 17)).toBe(`${MESSAGE_ID}.rebotado.17`);
  });
});
