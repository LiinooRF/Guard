import { esCodigoQrDePunto } from '../_lib/bridge/protocol';

/**
 * Que camino de marcado le ofrece la pantalla al guardia (#227).
 *
 * Vive fuera del componente porque es la unica parte de esta funcion que se
 * puede probar sin navegador —el jest de la web corre `*.spec.ts` y no renderiza
 * (ver `apps/web/jest.config.js`)— y porque la decision cruza tres fuentes que
 * no se parecen: lo que trae el TELEFONO (antena, camara), lo que sabe hacer el
 * SHELL instalado (el minor del protocolo) y lo que la EMPRESA permite
 * (`allowQrFallback`).
 *
 * La regla del producto que ordena todo lo demas: el QR es respaldo MARCADO.
 * Una etiqueta NFC pegada obliga a estar parado frente al punto; un QR se
 * fotografia una vez y se reusa desde la garita. Si en la pantalla los dos
 * caminos se vieran iguales, nadie compraria etiquetas y el producto perderia
 * justo lo que lo hace valer. Por eso el QR nunca es el boton grande cuando hay
 * NFC, y cuando es el unico camino se dice con todas sus letras.
 */

export type ModoEscaneo =
  /** Camino normal: etiqueta NFC. */
  | 'nfc'
  /** El telefono no tiene antena; el QR es lo unico que queda. */
  | 'solo-qr'
  /** Ni antena ni respaldo: este guardia no puede marcar puntos. */
  | 'ninguno';

export interface OpcionesEscaneo {
  readonly modo: ModoEscaneo;
  /** Mostrar el boton grande de NFC. */
  readonly nfc: boolean;
  /** Mostrar el camino por QR (grande si es el unico, discreto si es respaldo). */
  readonly qr: boolean;
  /** Por que el camino no es el normal. `undefined` = no hay nada que explicar. */
  readonly aviso?: string;
}

export interface CapacidadesEscaneo {
  /** El shell saludo. En el escritorio del supervisor esto es `false`. */
  readonly hayPuente: boolean;
  readonly tieneNfc: boolean;
  /** El shell entiende `qr.scan.start` y el equipo tiene camara. */
  readonly puedeEscanearQr: boolean;
  /** Regla `allowQrFallback` del tenant, resuelta en la cascada del recinto. */
  readonly qrPermitidoPorReglas: boolean;
}

const SIN_ANTENA_SIN_RESPALDO =
  'Este teléfono no tiene antena NFC y no puede registrar puntos. Avisa a tu supervisor.';
const SIN_ANTENA_CON_QR =
  'Este teléfono no tiene antena NFC. Marca cada punto con el código QR pegado en él: ' +
  'queda registrado como respaldo y tu supervisor lo ve así.';
const SIN_ANTENA_QR_BLOQUEADO =
  'Este teléfono no tiene antena NFC y tu empresa no permite el respaldo por QR. ' +
  'Avisa a tu supervisor: necesitas otro teléfono para esta ronda.';
const SIN_ANTENA_APP_ANTIGUA =
  'Este teléfono no tiene antena NFC. Actualiza SentryCore desde Google Play para ' +
  'poder marcar los puntos con el código QR.';

/** Texto del boton cuando el QR es el unico camino. */
export const BOTON_QR_PRINCIPAL = 'Escanear código QR del punto';
/**
 * Texto del acceso discreto al respaldo cuando el NFC funciona.
 *
 * Es una ACCIÓN, no un diagnóstico. Decía "La etiqueta no responde: usar el QR
 * del punto" y un usuario real lo leyó como un error DOS veces en la misma
 * sesión de prueba — un botón siempre visible cuyo texto afirma una falla se
 * lee como falla, sobre todo a las 3 de la mañana. El "cuándo usarlo" vive en
 * la nota de abajo, que es donde se explica sin gritar.
 */
export const BOTON_QR_RESPALDO = 'Usar el QR del punto';
export const NOTA_QR_RESPALDO =
  'Si la etiqueta no responde, escanea el QR del punto: queda marcado como evidencia más débil que la etiqueta.';

export function opcionesDeEscaneo(capacidades: CapacidadesEscaneo): OpcionesEscaneo {
  // Sin shell nativo no se escanea de ninguna forma: el QR tambien viaja por el
  // puente. El aviso de "esto es solo desde la app" lo pone `useGuardBridge`,
  // que es quien sabe por que no hay puente.
  if (!capacidades.hayPuente) {
    return { modo: 'ninguno', nfc: false, qr: false };
  }

  const qr = capacidades.puedeEscanearQr && capacidades.qrPermitidoPorReglas;

  if (capacidades.tieneNfc) {
    // Con antena el camino normal NO cambia: mismo boton, mismo texto, misma
    // posicion. El respaldo aparece debajo y en chico, para la etiqueta rota.
    return { modo: 'nfc', nfc: true, qr };
  }

  if (qr) {
    return { modo: 'solo-qr', nfc: false, qr: true, aviso: SIN_ANTENA_CON_QR };
  }

  return { modo: 'ninguno', nfc: false, qr: false, aviso: avisoSinCamino(capacidades) };
}

/**
 * Sin antena y sin QR el guardia queda sin ronda, asi que el aviso tiene que
 * decir QUE HACER y a quien reclamarle. No es lo mismo que la empresa lo haya
 * apagado (lo arregla el administrador en un minuto) a que la app instalada sea
 * vieja (lo arregla el guardia desde Play) o que el telefono no tenga camara
 * (no lo arregla nadie).
 */
function avisoSinCamino(capacidades: CapacidadesEscaneo): string {
  if (!capacidades.qrPermitidoPorReglas) return SIN_ANTENA_QR_BLOQUEADO;
  if (!capacidades.puedeEscanearQr) return SIN_ANTENA_APP_ANTIGUA;
  return SIN_ANTENA_SIN_RESPALDO;
}

/**
 * `undefined` cuando el codigo sirve. Se comprueba en el portal ademas de en el
 * shell porque el shell viejo no existe todavia en todos los telefonos y porque
 * mandar a la API un texto que ya sabemos que no resuelve gasta el unico
 * intento con señal que el guardia puede tener parado frente al punto.
 */
export function motivoQrInvalido(texto: string): string | undefined {
  return esCodigoQrDePunto(texto.trim())
    ? undefined
    : 'Ese código no es de un punto de SentryCore. Busca el QR pegado en el punto de control.';
}

export type MetodoEscaneo = 'nfc' | 'qr';

/** Etiqueta corta para la lista de puntos y el resumen. */
export const ETIQUETA_METODO: Record<MetodoEscaneo, string> = {
  nfc: 'NFC',
  qr: 'QR',
};
