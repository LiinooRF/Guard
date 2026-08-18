import { WEBHOOK_VENTANA_SEGUNDOS } from './registro-envios.constants';
import { firmar } from './registro-envios.firma';
import {
  crearTraductorWebhook,
  type PeticionWebhook,
  type Traduccion,
} from './registro-envios.traductor';
import { TraductorContratoInterno } from './registro-envios.traductor-interno';

const SECRETO = 'secreto-de-pruebas-que-no-esta-en-ningun-entorno';
const MESSAGE_ID = 'abc123@sentrycore.example';
const AHORA_SEG = 1_756_000_000;
const AHORA_MS = AHORA_SEG * 1000;

/** Un elemento del contrato interno, ya firmado salvo que el test diga otra cosa. */
function elemento(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = { messageId: MESSAGE_ID, evento: 'entregado', timestamp: AHORA_SEG };
  const conOverrides = { ...base, ...overrides };
  return {
    ...conOverrides,
    firma:
      'firma' in overrides
        ? overrides.firma
        : firmar(
            SECRETO,
            String(conOverrides.messageId),
            String(conOverrides.evento),
            Number(conOverrides.timestamp),
          ),
  };
}

function peticion(cuerpo: unknown, recibidoEnMs = AHORA_MS): PeticionWebhook {
  return { cabeceras: {}, cuerpo, recibidoEnMs };
}

function traducirCon(secreto: string | undefined, cuerpo: unknown): Promise<Traduccion> {
  return new TraductorContratoInterno(secreto).traducir(peticion(cuerpo));
}

function traducir(cuerpo: unknown): Promise<Traduccion> {
  return traducirCon(SECRETO, cuerpo);
}

describe('crearTraductorWebhook', () => {
  it('arma el traductor del contrato interno', () => {
    const traductor = crearTraductorWebhook({
      NOTIF_WEBHOOK_DRIVER: 'interno',
      NOTIF_WEBHOOK_SECRET: SECRETO,
    });

    expect(traductor).toBeInstanceOf(TraductorContratoInterno);
    expect(traductor.nombre).toBe('interno');
  });

  it('arranca sin secreto: el canal falla cerrado en cada peticion, no al levantar', async () => {
    // Negarse a construir dejaria la API sin arrancar por un canal de
    // notificaciones sin configurar. Mismo criterio que PUSH_DRIVER.
    const traductor = crearTraductorWebhook({
      NOTIF_WEBHOOK_DRIVER: 'interno',
      NOTIF_WEBHOOK_SECRET: undefined,
    });

    await expect(traductor.traducir(peticion(elemento()))).resolves.toEqual({
      ok: false,
      motivo: 'sin_secreto',
    });
  });
});

describe('TraductorContratoInterno · una peticion', () => {
  it('traduce un evento firmado y fresco al vocabulario del registro', async () => {
    await expect(traducir(elemento({ motivo: '550 5.1.1 casilla inexistente' }))).resolves.toEqual({
      ok: true,
      eventos: [
        {
          messageId: MESSAGE_ID,
          evento: 'entregado',
          ocurridoEn: new Date(AHORA_MS),
          motivo: '550 5.1.1 casilla inexistente',
        },
      ],
    });
  });

  it('un rebote llega con su motivo, que es lo que el registro guarda', async () => {
    const traduccion = await traducir(
      elemento({ evento: 'rebotado', motivo: '  552 buzón lleno  ' }),
    );

    expect(traduccion).toEqual({
      ok: true,
      eventos: [expect.objectContaining({ evento: 'rebotado', motivo: '552 buzón lleno' })],
    });
  });

  it('sin motivo el evento viaja con null y no con undefined', async () => {
    const traduccion = await traducir(elemento({ evento: 'reclamo' }));

    expect(traduccion).toEqual({ ok: true, eventos: [expect.objectContaining({ motivo: null })] });
  });

  it('falla cerrada cuando no hay secreto configurado', async () => {
    await expect(traducirCon(undefined, elemento())).resolves.toEqual({
      ok: false,
      motivo: 'sin_secreto',
    });
    await expect(traducirCon('   ', elemento())).resolves.toEqual({
      ok: false,
      motivo: 'sin_secreto',
    });
  });

  it('rechaza una firma de otro secreto', async () => {
    const ajena = elemento({ firma: firmar('otro-secreto-distinto', MESSAGE_ID, 'entregado', AHORA_SEG) });

    await expect(traducir(ajena)).resolves.toEqual({ ok: false, motivo: 'firma_invalida' });
  });

  it('rechaza si se altera cualquiera de los tres campos firmados', async () => {
    const original = elemento();

    for (const alterado of [
      { ...original, messageId: 'otro@sentrycore.example' },
      { ...original, evento: 'rebotado' },
      { ...original, timestamp: AHORA_SEG - 1 },
    ]) {
      await expect(traducir(alterado)).resolves.toEqual({ ok: false, motivo: 'firma_invalida' });
    }
  });

  it('distingue la firma ausente de la invalida, aunque las dos den 403', async () => {
    const sinFirma = elemento();
    delete sinFirma.firma;

    await expect(traducir(sinFirma)).resolves.toEqual({ ok: false, motivo: 'firma_ausente' });
  });

  it('rechaza una peticion vieja aunque la firma calce', async () => {
    const vieja = elemento({ timestamp: AHORA_SEG - WEBHOOK_VENTANA_SEGUNDOS - 1 });

    await expect(traducir(vieja)).resolves.toEqual({ ok: false, motivo: 'vencida' });
  });

  it('acepta el timestamp como cadena: el relay serializa a JSON', async () => {
    // La cadena canonica se arma con el numero ya convertido, asi que las dos
    // formas producen la misma firma.
    const comoCadena = { ...elemento(), timestamp: String(AHORA_SEG) };

    await expect(traducir(comoCadena)).resolves.toEqual({
      ok: true,
      eventos: [expect.objectContaining({ ocurridoEn: new Date(AHORA_MS) })],
    });
  });

  it('rechaza un cuerpo que no es un objeto JSON', async () => {
    for (const cuerpo of [null, 'entregado', 42, true]) {
      await expect(traducir(cuerpo)).resolves.toEqual({ ok: false, motivo: 'cuerpo_invalido' });
    }
  });

  it('rechaza el cuerpo al que le falta cualquiera de los campos firmados', async () => {
    for (const campo of ['messageId', 'evento', 'timestamp']) {
      const incompleto = elemento();
      delete incompleto[campo];
      await expect(traducir(incompleto)).resolves.toEqual({ ok: false, motivo: 'cuerpo_invalido' });
    }
  });

  it('rechaza un Message-ID mas largo de lo que admite la columna', async () => {
    // mail_deliveries.provider_message_id: CHECK length BETWEEN 1 AND 400.
    const largo = elemento({ messageId: 'x'.repeat(401) });

    await expect(traducir(largo)).resolves.toEqual({ ok: false, motivo: 'cuerpo_invalido' });
  });
});

describe('TraductorContratoInterno · eventos que el registro no modela', () => {
  it('acepta y descarta una apertura firmada, para que el relay deje de reintentar', async () => {
    await expect(traducir(elemento({ evento: 'open' }))).resolves.toEqual({ ok: true, eventos: [] });
  });

  it('pero una apertura SIN firmar se rechaza igual: primero se autentica', async () => {
    // Al reves, el endpoint contestaria distinto segun lo que le manden sin
    // haber verificado nada, que es un oraculo gratis para quien lo pruebe.
    const sinFirmar = { ...elemento({ evento: 'open' }), firma: 'f'.repeat(64) };

    await expect(traducir(sinFirmar)).resolves.toEqual({ ok: false, motivo: 'firma_invalida' });
  });

  it('nunca deja pasar un estado que el sistema sabe de primera mano', async () => {
    // 'encolado', 'enviado' y 'fallido' los escribe la cola: nadie de afuera
    // puede reportarlos aunque firme bien.
    for (const evento of ['encolado', 'enviado', 'fallido']) {
      await expect(traducir(elemento({ evento }))).resolves.toEqual({ ok: true, eventos: [] });
    }
  });
});

describe('TraductorContratoInterno · lotes', () => {
  it('traduce un lote donde cada elemento trae su propia firma', async () => {
    const lote = [
      elemento(),
      elemento({ messageId: 'def456@sentrycore.example', evento: 'rebotado', motivo: '550 rechazado' }),
    ];

    await expect(traducir(lote)).resolves.toEqual({
      ok: true,
      eventos: [
        expect.objectContaining({ messageId: MESSAGE_ID, evento: 'entregado' }),
        expect.objectContaining({ messageId: 'def456@sentrycore.example', evento: 'rebotado' }),
      ],
    });
  });

  it('un solo elemento mal firmado tumba el lote completo', async () => {
    // Aplicar los buenos y callar el malo le devolveria 202 a quien inyecto el
    // evento falso, y el rechazo no quedaria en ninguna parte.
    const lote = [elemento(), { ...elemento({ messageId: 'colado@sentrycore.example' }), firma: 'f'.repeat(64) }];

    await expect(traducir(lote)).resolves.toEqual({ ok: false, motivo: 'firma_invalida' });
  });

  it('un lote vacio es un 202 sin nada que aplicar, no un rechazo', async () => {
    await expect(traducir([])).resolves.toEqual({ ok: true, eventos: [] });
  });

  it('un lote de aperturas firmadas no aporta eventos y tampoco se rechaza', async () => {
    await expect(traducir([elemento({ evento: 'open' }), elemento({ evento: 'click' })])).resolves.toEqual(
      { ok: true, eventos: [] },
    );
  });

  it('rechaza un lote mas grande que el tope, sin mirar ninguna firma', async () => {
    const enorme = Array.from({ length: 101 }, () => elemento());

    await expect(traducir(enorme)).resolves.toEqual({ ok: false, motivo: 'cuerpo_invalido' });
  });
});
