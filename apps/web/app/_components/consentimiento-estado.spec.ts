/**
 * Pruebas de la puerta de consentimiento (#78).
 *
 * Lo que se prueba no es el renderizado sino las decisiones que, si se
 * equivocan, no las cacha nadie mirando la pantalla: cuando se interrumpe el
 * ingreso, cuando NO, que el interruptor que manda sea el correcto, y que quien
 * ya dijo que no deje de ser interpelado.
 *
 * LAS FIXTURES SON ESTADOS QUE EL SERVIDOR PRODUCE DE VERDAD, no combinaciones
 * inventadas. Cada una dice de donde sale, porque la version anterior de este
 * archivo fijaba `('reaceptar','desactualizado')` —que solo ocurre si el tenant
 * APAGO `consentReacceptOnNewPolicy`— y daba por buena una puerta que con la
 * configuracion de fabrica no se abria nunca. Diez pruebas verdes confirmando
 * lo que el autor creia.
 *
 * El recorrido real esta en `ConsentService.currentPolicy` (apps/api/src/
 * consent/consent.service.ts): `estadoDe` corta en `revoked_at !== null` ANTES
 * de comparar versiones, y `publishPolicy` pone `revoked_at = now()` a todos
 * los consentimientos del texto anterior cuando la re-aceptacion esta activa.
 */
import {
  bajadaDePuerta,
  debeMostrarPuerta,
  tituloDePuerta,
  type AvisoParaPuerta,
  type AccionConsentimiento,
  type EstadoAceptacion,
} from './consentimiento-estado';

function aviso(campos: {
  actionRequired: AccionConsentimiento;
  status: EstadoAceptacion;
  acceptedVersion: string | null;
  policyVersion: string | null;
  enabled?: boolean;
}): AvisoParaPuerta {
  return {
    actionRequired: campos.actionRequired,
    policy: campos.policyVersion === null ? null : { version: campos.policyVersion },
    acceptance: { status: campos.status, acceptedVersion: campos.acceptedVersion },
    tracking: { enabled: campos.enabled ?? true },
  };
}

/** Nunca acepto nada y hay aviso "v2" publicado. */
const primerIngreso = aviso({
  actionRequired: 'aceptar',
  status: 'nunca_aceptado',
  acceptedVersion: null,
  policyVersion: 'v2',
});

/**
 * La empresa publico "v2" con `consentReacceptOnNewPolicy` ACTIVO (lo de
 * fabrica): la fila de "v1" quedo con `revoked_at = now()`, asi que `estadoDe`
 * devuelve 'revocado' y `actionRequired` sale 'aceptar'. Este es el caso que la
 * puerta decia cubrir y no cubria.
 */
const avisoNuevoConReaceptacion = aviso({
  actionRequired: 'aceptar',
  status: 'revocado',
  acceptedVersion: 'v1',
  policyVersion: 'v2',
});

/**
 * La misma publicacion con la re-aceptacion APAGADA: la fila de "v1" sigue
 * vigente, `estadoDe` compara versiones y devuelve 'desactualizado'. Es el
 * unico escenario en que llega 'reaceptar'.
 */
const avisoNuevoSinReaceptacion = aviso({
  actionRequired: 'reaceptar',
  status: 'desactualizado',
  acceptedVersion: 'v1',
  policyVersion: 'v2',
});

/** La persona apreto "No acepto" sobre el texto que hoy esta publicado. */
const negativaSobreElTextoVigente = aviso({
  actionRequired: 'aceptar',
  status: 'revocado',
  acceptedVersion: 'v2',
  policyVersion: 'v2',
});

/** Acepto el texto vigente: no hay nada que interrumpir. */
const aceptacionVigente = aviso({
  actionRequired: 'ninguna',
  status: 'vigente',
  acceptedVersion: 'v2',
  policyVersion: 'v2',
});

describe('debeMostrarPuerta', () => {
  it('interrumpe el primer ingreso de quien nunca acepto', () => {
    expect(debeMostrarPuerta(primerIngreso, false)).toBe(true);
  });

  /*
   * El caso que el issue nombra: "la empresa actualizo el aviso". Con la regla
   * de fabrica el servidor lo manda como revocado + aceptar, indistinguible en
   * `status` de una negativa. Lo unico que los separa es la version aceptada.
   */
  it('interrumpe tras publicar un texto nuevo, con la re-aceptacion activa', () => {
    expect(debeMostrarPuerta(avisoNuevoConReaceptacion, false)).toBe(true);
  });

  it('interrumpe tras publicar un texto nuevo, con la re-aceptacion apagada', () => {
    expect(debeMostrarPuerta(avisoNuevoSinReaceptacion, false)).toBe(true);
  });

  it('no interrumpe a quien tiene el aviso vigente', () => {
    expect(debeMostrarPuerta(aceptacionVigente, false)).toBe(false);
  });

  /*
   * gpsTrackingEnabled apagado = no se guarda ni un punto para nadie. Sin nada
   * que registrar no hay aviso previo que dar, y frenar la ronda por un tramite
   * sin objeto seria puro estorbo. Ojo: esto NO es gpsSharingRequired, que es
   * obligatorio vs opcional y con el que si se registra el recorrido de quien
   * acepta.
   */
  it('no interrumpe si la empresa tiene el registro de recorrido apagado', () => {
    expect(debeMostrarPuerta({ ...primerIngreso, tracking: { enabled: false } }, false)).toBe(
      false,
    );
    expect(
      debeMostrarPuerta({ ...avisoNuevoConReaceptacion, tracking: { enabled: false } }, false),
    ).toBe(false);
  });

  /*
   * Poner la misma pantalla delante de quien ya se nego, en cada ingreso, es
   * presionarlo para que acepte. Un consentimiento asi no acredita nada. Pero
   * la negativa vale para EL TEXTO que tenia delante: por eso se compara la
   * version y no el `status`.
   */
  it('no vuelve a interpelar a quien dijo que no al texto vigente', () => {
    expect(debeMostrarPuerta(negativaSobreElTextoVigente, false)).toBe(false);
  });

  /*
   * Se nego a "v1" y despues la empresa publico "v2": es otra cosa la que se le
   * esta informando, asi que se le vuelve a preguntar. (`publishPolicy` no toca
   * esta fila: su UPDATE pide `revoked_at IS NULL`.)
   */
  it('vuelve a preguntar a quien se nego a un texto anterior', () => {
    expect(
      debeMostrarPuerta(
        aviso({
          actionRequired: 'aceptar',
          status: 'revocado',
          acceptedVersion: 'v1',
          policyVersion: 'v2',
        }),
        false,
      ),
    ).toBe(true);
  });

  /*
   * La empresa todavia no publico el aviso: la deuda es de ella. Dejar al
   * trabajador sin poder entrar seria castigarlo por una omision ajena, y el
   * servidor igual rechaza la traza sin consentimiento vigente.
   */
  it('no interrumpe cuando falta publicar el aviso', () => {
    expect(
      debeMostrarPuerta(
        aviso({
          actionRequired: 'publicar_aviso',
          status: 'nunca_aceptado',
          acceptedVersion: null,
          policyVersion: null,
        }),
        false,
      ),
    ).toBe(false);
  });

  /*
   * Sin aviso publicado, a quien acepto un texto retirado el servidor lo manda
   * como 'desactualizado' + 'publicar_aviso'. Tampoco se interrumpe: no hay
   * texto que mostrarle.
   */
  it('no interrumpe si el texto que acepto ya no esta publicado y no hay otro', () => {
    expect(
      debeMostrarPuerta(
        aviso({
          actionRequired: 'publicar_aviso',
          status: 'desactualizado',
          acceptedVersion: 'v1',
          policyVersion: null,
        }),
        false,
      ),
    ).toBe(false);
  });

  /*
   * Al pulsar "No acepto" sin tener un consentimiento previo, el servidor no
   * escribe ninguna fila (revokeConsent solo actualiza filas vigentes), asi que
   * el estado sigue siendo `nunca_aceptado`. Sin esta memoria de la carga la
   * puerta se reabriria sola y dejaria a la persona encerrada en un bucle.
   */
  it('se cierra en cuanto la persona responde, aunque el estado del servidor no cambie', () => {
    expect(debeMostrarPuerta(primerIngreso, true)).toBe(false);
  });

  it('no interrumpe si el aviso no se pudo leer', () => {
    expect(debeMostrarPuerta(null, false)).toBe(false);
  });
});

describe('textos de la puerta', () => {
  it('distingue el primer ingreso de una version nueva', () => {
    expect(tituloDePuerta(primerIngreso)).not.toBe(tituloDePuerta(avisoNuevoConReaceptacion));
    expect(bajadaDePuerta(primerIngreso)).not.toBe(bajadaDePuerta(avisoNuevoConReaceptacion));
  });

  /*
   * El texto de "tu empresa actualizo el aviso" tiene que salir tambien cuando
   * el servidor manda 'aceptar' + 'revocado', que es como llega la publicacion
   * con la regla de fabrica. Si se guiara por `actionRequired === 'reaceptar'`,
   * a esa persona le diria "Antes de empezar, lee este aviso" como si nunca
   * hubiera aceptado nada — y esa rama seria codigo muerto.
   */
  it('reconoce el texto nuevo aunque el servidor lo mande como revocado', () => {
    expect(tituloDePuerta(avisoNuevoConReaceptacion)).toBe(
      tituloDePuerta(avisoNuevoSinReaceptacion),
    );
    expect(tituloDePuerta(avisoNuevoConReaceptacion)).toContain('actualizó');
    expect(bajadaDePuerta(avisoNuevoConReaceptacion)).toContain('quedó sin efecto');
  });

  /*
   * La bajada tiene que decir que se puede seguir trabajando sin aceptar. Si
   * algun dia alguien la reescribe y borra esa frase, la pantalla pasa a ser
   * una exigencia y no un aviso.
   */
  it('el primer ingreso avisa que se puede trabajar sin aceptar', () => {
    expect(bajadaDePuerta(primerIngreso)).toContain('sigues trabajando');
  });
});
