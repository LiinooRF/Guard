/**
 * Enmascarado de datos sensibles antes de que un evento salga del proceso (#27).
 *
 * ESTO ES LA SEGUNDA REJA, NO LA PRIMERA.
 * La primera es que el evento se arma campo por campo desde un tipo cerrado
 * (crash-event.ts) y que el DTO de entrada corre con `forbidNonWhitelisted`:
 * nadie puede colar un campo extra con el nombre del guardia adentro. Este
 * archivo cubre los dos campos que por naturaleza son texto libre y no se
 * pueden cerrar: el mensaje del error y la pila.
 *
 * LO QUE ESTE ARCHIVO NO PUEDE HACER
 * No puede detectar el nombre de una persona. "Juan Perez" es indistinguible de
 * cualquier otro par de palabras y una lista de nombres chilenos seria a la vez
 * inutil y ofensiva. Por eso el nombre no se protege enmascarando: se protege
 * NO PONIENDOLO — ninguna consulta de este modulo lee `users.full_name` ni lo
 * pasa a un evento. Si algun dia alguien mete el nombre en el mensaje de una
 * excepcion, esto no lo va a salvar; lo que lo salva es la revision del PR.
 *
 * Ver docs/operations/crash-reporting.md.
 */

/** Un patron con nombre, para poder auditar QUE se enmascaro. */
interface PatronSensible {
  nombre: string;
  patron: RegExp;
  reemplazo: string;
}

/**
 * El orden importa: lo mas especifico primero. `password=juan@correo.cl` tiene
 * que quedar como `password=[oculto]` y no como `password=[correo]`, porque lo
 * segundo confirma que la contraseña era un correo.
 *
 * Todos los patrones son globales; se usan con `String.replace`, que reinicia
 * `lastIndex` cuando se le pasa un patron global, asi que compartirlos entre
 * llamadas es seguro. `.test()` sobre estos patrones NO lo seria — por eso
 * `auditarTexto` clona cada patron antes de probarlo.
 */
const PATRONES: readonly PatronSensible[] = [
  {
    // Rutas personales: /home/jperez, /Users/jperez, C:\Users\jperez. La pila de
    // una compilacion hecha en el notebook de alguien lleva su nombre de usuario.
    nombre: 'ruta_personal',
    patron: /((?:\/home\/|\/Users\/)|(?:[A-Za-z]:\\Users\\))[^/\\\s"']+/g,
    reemplazo: '$1[usuario]',
  },
  {
    nombre: 'jwt',
    patron: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
    reemplazo: '[jwt]',
  },
  {
    nombre: 'credencial_http',
    patron: /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    reemplazo: '$1 [oculto]',
  },
  {
    // clave=valor y clave: valor, con o sin comillas.
    //
    // El reemplazo NO deja el `=`: si dejara `token=[oculto]`, el propio texto
    // enmascarado volveria a parecer un par clave-valor con secreto, y
    // `auditarTexto` —que es lo que usan los tests para afirmar que no queda
    // nada sensible— lo marcaria para siempre. Se enmascara para quedar limpio,
    // no para quedar sospechoso.
    nombre: 'clave_secreta',
    patron:
      /\b(password|passwd|contrasena|clave|secret|secreto|token|refresh_token|access_token|authorization|cookie|set-cookie|api[_-]?key|apikey|dsn|pin|otp)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;)}\]]+)/gi,
    reemplazo: '$1 [oculto]',
  },
  {
    nombre: 'correo',
    patron: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    reemplazo: '[correo]',
  },
  {
    // RUT chileno, con o sin puntos y con guion.
    nombre: 'rut',
    patron: /\b\d{1,2}\.?\d{3}\.?\d{3}\s*-\s*[\dkK]\b/g,
    reemplazo: '[rut]',
  },
  {
    // Movil chileno, con o sin +56 y con o sin separadores. El lookbehind evita
    // engancharse a la mitad de un numero mas largo: sin el, `\b` no sirve,
    // porque entre el 6 de "+56" y el 9 siguiente no hay limite de palabra.
    nombre: 'telefono',
    patron: /(?<![\d.])(?:\+?56[\s-]?)?9[\s-]?\d{4}[\s-]?\d{4}(?![\d.])/g,
    reemplazo: '[telefono]',
  },
  {
    // Par de coordenadas: -33.4489,-70.6693. Cuatro decimales o mas ya son
    // metros; con menos no se distingue de un numero cualquiera.
    nombre: 'coordenadas',
    patron: /-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/g,
    reemplazo: '[coordenadas]',
  },
  {
    nombre: 'coordenada_suelta',
    patron:
      /\b(lat|latitud|latitude|lng|lon|long|longitud|longitude|accuracy|precision|altitude|altitud)\b\s*[:=]\s*-?\d+(?:\.\d+)?/gi,
    reemplazo: '$1 [coordenada]',
  },
  {
    nombre: 'ip',
    patron: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g,
    reemplazo: '[ip]',
  },
  {
    // Hashes, ids de sesion, claves en hexadecimal. 32 nibbles son 16 bytes: por
    // debajo hay demasiados falsos positivos (offsets, direcciones cortas).
    nombre: 'hexadecimal_largo',
    patron: /\b[A-Fa-f0-9]{32,}\b/g,
    reemplazo: '[hash]',
  },
];

/**
 * Tope de un mensaje enmascarado. NO es un numero nuestro: es exactamente el
 * CHECK de la columna `error_message`
 * (`length(error_message) BETWEEN 1 AND 2000`, ver
 * 1725559200000-CreateAppCrashReports.ts). Si lo que sale de aca lo supera,
 * Postgres rechaza la fila entera y el reporte de la caida se pierde.
 */
export const LARGO_MAX_MENSAJE = 2_000;

/** Lineas de pila que se conservan. Mas abajo ya es ruido del framework. */
export const MAX_LINEAS_PILA = 40;
/** Tope por linea de pila: una linea gigante suele ser un dato pegado, no codigo. */
export const LARGO_MAX_LINEA_PILA = 500;

/**
 * Marca de que el texto venia mas largo. Va DENTRO del tope, nunca encima: si
 * se sumara al final, el resultado mediria `largoMaximo + 5` y reventaria el
 * CHECK de la columna justo en el caso que este archivo existe para cubrir.
 */
const SUFIJO_CORTE = '[...]';

/**
 * Enmascara y acota un texto libre. Nunca lanza: si esto reventara, el manejo
 * de un error se transformaria en otro error.
 */
export function depurarTexto(texto: unknown, largoMaximo = LARGO_MAX_MENSAJE): string {
  if (typeof texto !== 'string' || texto.length === 0) return '';

  let salida = texto;
  try {
    for (const { patron, reemplazo } of PATRONES) {
      salida = salida.replace(patron, reemplazo);
    }
  } catch {
    // Un texto imposible de procesar se descarta entero. Perder el mensaje es
    // molesto; filtrarlo sin enmascarar es un incidente.
    return '[texto no procesable]';
  }

  // Los caracteres de control rompen el JSON por linea del log estructurado.
  // eslint-disable-next-line no-control-regex -- el proposito de esta linea es sacar caracteres de control; la regla apunta al caso contrario.
  salida = salida.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ');

  if (salida.length <= largoMaximo) return salida;

  // `largoMaximo` es un TOPE, no la cantidad que se conserva: el sufijo se
  // descuenta del corte. Con un tope mas corto que el propio sufijo no hay
  // lugar para la marca y se corta a secas — nunca se devuelve de mas.
  if (largoMaximo <= SUFIJO_CORTE.length) return salida.slice(0, largoMaximo);

  return `${salida.slice(0, largoMaximo - SUFIJO_CORTE.length)}${SUFIJO_CORTE}`;
}

/**
 * Enmascara una etiqueta corta (version, modelo). No se le aplican los patrones
 * de texto libre: `1.2.3.4` de version se veria como una IP. Se limita a sacar
 * control y comillas, y a acotar.
 */
export function depurarEtiqueta(valor: unknown, largoMaximo = 64): string {
  if (typeof valor !== 'string') return '';
  // eslint-disable-next-line no-control-regex -- idem: se sacan a proposito.
  const limpio = valor.replace(/[\u0000-\u001f"\\]/g, ' ').trim();
  return limpio.length > largoMaximo ? limpio.slice(0, largoMaximo) : limpio;
}

/**
 * Pila depurada, linea a linea y acotada. Devuelve un arreglo porque el
 * envelope necesita los cuadros separados y porque asi el tope de lineas es
 * explicito en vez de un `slice` perdido en otro archivo.
 */
export function depurarPila(pila: unknown, maxLineas = MAX_LINEAS_PILA): string[] {
  if (typeof pila !== 'string' || pila.length === 0) return [];

  return pila
    .split('\n')
    .map((linea) => linea.trim())
    .filter((linea) => linea.length > 0)
    .slice(0, maxLineas)
    .map((linea) => depurarTexto(linea, LARGO_MAX_LINEA_PILA))
    .filter((linea) => linea.length > 0);
}

/**
 * Ruta HTTP sin query string y con los tokens del path enmascarados.
 *
 * El query string se descarta COMPLETO, no se filtra: es donde terminan los
 * tokens de un solo uso y los filtros con nombres de personas, y una lista de
 * parametros permitidos se desactualiza en el primer endpoint nuevo.
 */
export function depurarRuta(ruta: unknown): string {
  if (typeof ruta !== 'string' || ruta.length === 0) return '';
  const sinQuery = ruta.split('?')[0] ?? '';
  // Mismo criterio que loggedPath() en request-logging.middleware.ts, repetido
  // aca porque aquella funcion solo conoce las dos rutas con credencial en el
  // path y esta ademas tapa cualquier uuid.
  return depurarTexto(
    sinQuery
      .replace(/^(\/api)?\/(auth\/handoff|push\/devices)\/[^/]+\/?$/, '$1/$2/:token')
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
        ':id',
      ),
    200,
  );
}

/**
 * Que patrones sensibles quedan en un texto. Solo para tests y para el chequeo
 * de arranque: es la forma de afirmar "ningun evento lleva datos personales"
 * con algo ejecutable en vez de con una promesa en el PR.
 */
export function auditarTexto(texto: string): string[] {
  const encontrados: string[] = [];
  for (const { nombre, patron } of PATRONES) {
    // Clon: `.test()` sobre un patron global avanza lastIndex y el siguiente
    // llamado empezaria a la mitad del texto, devolviendo falsos negativos.
    if (new RegExp(patron.source, patron.flags.replace('g', '')).test(texto)) {
      encontrados.push(nombre);
    }
  }
  return encontrados;
}
