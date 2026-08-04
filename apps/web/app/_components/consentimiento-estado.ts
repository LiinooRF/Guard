/**
 * Cuando el aviso de geolocalizacion INTERRUMPE el ingreso (#78).
 *
 * Modulo puro a proposito: sin React, sin navegador y sin fetch. La decision de
 * "esta persona tiene que leer el aviso antes de seguir" es la unica parte de la
 * pantalla que puede equivocarse de forma silenciosa, y asi se puede probar.
 *
 * LA REGLA QUE SE LEE ACA ES gpsTrackingEnabled, NO gpsSharingRequired.
 * Son dos cosas distintas y confundirlas ya costo un aviso legal que mentia:
 *
 *   - `gpsTrackingEnabled` (llega como `tracking.enabled`) es el INTERRUPTOR:
 *     apagado no se guarda ni un punto para nadie. Sin nada que registrar no hay
 *     nada que informar por adelantado, asi que no se interrumpe el trabajo.
 *   - `gpsSharingRequired` es obligatorio vs OPCIONAL, y opcional NO es apagado:
 *     a quien acepta se le registra el recorrido igual. Si la puerta se apoyara
 *     en esa regla, con GPS "opcional" el trabajador no veria el aviso mientras
 *     el servidor si estaria guardando su recorrido.
 *
 * LO QUE MANDA ES LA VERSION DEL TEXTO, NO `status` NI `actionRequired`.
 * Esta puerta leia `status === 'revocado'` como "la persona dijo que no", y con
 * la configuracion de fabrica eso es falso:
 *
 *   - `consentReacceptOnNewPolicy` viene en `true` (packages/shared/src/rules.ts),
 *     asi que al publicar un aviso nuevo `ConsentService.publishPolicy` cierra
 *     TODOS los consentimientos vigentes del texto anterior
 *     (`UPDATE gps_consents SET revoked_at = now() WHERE revoked_at IS NULL AND
 *     policy_version <> $1`).
 *   - Despues de eso `estadoDe` corta en `if (aceptacion.revoked_at !== null)
 *     return 'revocado'` ANTES de comparar versiones, asi que el servidor
 *     responde `status:'revocado'` + `actionRequired:'aceptar'`. NUNCA
 *     'reaceptar' — salvo que el tenant apague la re-aceptacion.
 *
 * O sea: el cierre por publicacion y la negativa de la persona llegan
 * indistinguibles en `status`. Lo unico que los separa es QUE TEXTO acepto
 * (`acceptance.acceptedVersion`) contra el texto vigente (`policy.version`), y
 * eso es lo que se compara aca. La migracion lo dice con todas sus letras:
 * "Un texto nuevo NO se hereda: el consentimiento anterior se cierra y el
 * trabajador acepta de nuevo" (1724511600000-CreateTrackAndConsent).
 *
 * Lo de fondo lo tiene que arreglar el servidor —distinguir negativa de la
 * persona de cierre por publicacion, con un `revokedBy`/`closedByPolicy` en
 * GET /consent/policy— y va escrito en INTEGRACION.md. Mientras no exista, la
 * puerta no puede leer 'revocado' como decision del trabajador.
 */

export type AccionConsentimiento = 'ninguna' | 'aceptar' | 'reaceptar' | 'publicar_aviso';

export type EstadoAceptacion = 'vigente' | 'desactualizado' | 'revocado' | 'nunca_aceptado';

/**
 * Lo minimo que la puerta necesita del aviso.
 *
 * Es un subconjunto ESTRUCTURAL de `AvisoConsentimiento` (consentimiento-aviso
 * .tsx) y no un import, para que este archivo siga siendo puro y jest lo pueda
 * cargar sin arrastrar React. El vinculo lo hace igual el compilador: la puerta
 * le pasa un `AvisoConsentimiento` de verdad, asi que si el servidor agrega un
 * estado nuevo, `npm run typecheck` falla en la llamada en vez de dejar que la
 * puerta lo trate como un caso conocido.
 */
export interface AvisoParaPuerta {
  /**
   * Ya NO decide nada (ver el encabezado), pero se queda en el tipo a
   * proposito: es el canario. Si el servidor agrega una accion nueva,
   * `npm run typecheck` falla en la llamada de la puerta y obliga a mirar esta
   * decision, en vez de dejar que el caso nuevo pase de largo.
   */
  actionRequired: AccionConsentimiento;
  /** `null` = la empresa todavia no publica ningun aviso. */
  policy: { version: string } | null;
  acceptance: {
    /**
     * Tampoco decide (ver el encabezado): 'revocado' tapa dos cosas distintas.
     * Se queda por lo mismo que `actionRequired`, para que un estado nuevo del
     * servidor rompa el typecheck acá.
     */
    status: EstadoAceptacion;
    /** Version que la persona acepto alguna vez. `null` = nunca acepto nada. */
    acceptedVersion: string | null;
  };
  tracking: { enabled: boolean };
}

/**
 * ¿La persona no ha aceptado el TEXTO VIGENTE?
 *
 * Es la pregunta de la que cuelga todo: sin aceptacion del texto que hoy esta
 * publicado, el servidor no guarda su recorrido (lo aplica GeoService), y ese
 * es exactamente el estado que hay que contarle.
 */
function faltaAceptarElTextoVigente(aviso: AvisoParaPuerta): boolean {
  if (!aviso.policy) return false;
  return aviso.acceptance.acceptedVersion !== aviso.policy.version;
}

/**
 * ¿Ya habia aceptado un texto ANTERIOR? Distingue el primer ingreso de "la
 * empresa cambio el aviso", que son dos conversaciones distintas.
 *
 * No se apoya en `actionRequired === 'reaceptar'`: con la re-aceptacion activa
 * —que es lo de fabrica— ese valor no llega nunca; el servidor manda 'aceptar'
 * con `status:'revocado'`.
 */
function esTextoNuevo(aviso: AvisoParaPuerta): boolean {
  return aviso.acceptance.acceptedVersion !== null && faltaAceptarElTextoVigente(aviso);
}

/**
 * ¿Hay que mostrar el aviso ANTES que el resto de la pantalla?
 *
 * Se bloquea cuando la persona NO ha aceptado el texto vigente, en sus dos
 * formas:
 *
 *   - Nunca acepto nada: el primer ingreso, que es literalmente lo que pide el
 *     issue.
 *   - Acepto un texto anterior y la empresa publico otro: da lo mismo si el
 *     servidor lo cuenta como 'desactualizado' (re-aceptacion apagada) o como
 *     'revocado' (re-aceptacion activa, que es lo de fabrica). En los dos casos
 *     el texto que acepto ya no describe lo que se hace con su ubicacion.
 *
 * NO se bloquea a quien dijo que no AL TEXTO VIGENTE. Volver a poner la misma
 * pantalla delante de alguien que ya se nego, cada vez que abre la aplicacion,
 * es presion para que acepte — y un consentimiento arrancado con presion no
 * sirve ni legalmente ni ante un juicio laboral. La negativa vale para el texto
 * que la persona tenia delante: si despues la empresa publica otro, se le
 * vuelve a preguntar, porque es otra cosa la que se le esta informando.
 *
 * Tampoco se bloquea cuando no hay aviso publicado (`publicar_aviso`): la deuda
 * es de la empresa, no del trabajador, y dejarlo sin trabajar por eso seria
 * castigarlo por una omision ajena.
 *
 * @param yaRespondio respondio recien, en esta misma carga de la pagina.
 */
export function debeMostrarPuerta(
  aviso: AvisoParaPuerta | null,
  yaRespondio: boolean,
): boolean {
  if (!aviso) return false;
  if (yaRespondio) return false;
  if (!aviso.tracking.enabled) return false;
  // Sin texto publicado no hay nada que leer ni que aceptar.
  if (!aviso.policy) return false;
  /*
   * Y de ahi todo cuelga de UNA comparacion, la de la version:
   *
   *   - acepto el texto vigente        -> no se interrumpe.
   *   - se nego AL TEXTO VIGENTE       -> no se interrumpe: su fila apunta a esa
   *     misma version, ya respondio y se respeta. Es el unico caso en que
   *     'revocado' significa de verdad "dijo que no".
   *   - nunca acepto, o acepto uno anterior (lo mismo da si el servidor lo llama
   *     'desactualizado' o 'revocado') -> se interrumpe.
   *
   * `acceptance.status` no se lee a proposito: en el payload no distingue la
   * negativa del cierre por publicacion. Ver el encabezado.
   */
  return faltaAceptarElTextoVigente(aviso);
}

/** Titulo de la puerta. Distinto en el primer ingreso y en una version nueva. */
export function tituloDePuerta(aviso: AvisoParaPuerta): string {
  return esTextoNuevo(aviso)
    ? 'Tu empresa actualizó el aviso de ubicación'
    : 'Antes de empezar, lee este aviso';
}

/** La bajada. Dice que la decision es libre, porque tiene que serlo. */
export function bajadaDePuerta(aviso: AvisoParaPuerta): string {
  return esTextoNuevo(aviso)
    ? 'Cambió el texto que aceptaste antes, así que tu aceptación anterior quedó sin efecto. Léelo y decide de nuevo. Mientras no respondas, tu recorrido no se registra.'
    : 'Tu empresa quiere registrar tu ubicación mientras haces la ronda. Estamos obligados a informártelo antes de empezar y tú decides. Puedes aceptar o no aceptar: en los dos casos sigues trabajando igual.';
}
