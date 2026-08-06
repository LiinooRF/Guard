import { rm, rmdir } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';

/**
 * El lado de disco de la purga (#219).
 *
 * BORRAR LA FILA Y DEJAR EL ARCHIVO NO ES PURGAR
 * ----------------------------------------------
 * La evidencia son dos cosas: la fila en scan_photos/event_photos y el binario
 * bajo EVIDENCE_PATH. Si se borra solo la fila, la foto del guardia sigue
 * existiendo en el volumen para siempre y ademas ya nadie sabe de que empresa
 * era ni por que estaba ahi. Eso es peor que no purgar: es incumplir el plazo Y
 * perder la trazabilidad de lo que se sigue guardando.
 *
 * EL ORDEN ES ARCHIVO PRIMERO, FILA DESPUES
 * -----------------------------------------
 * Es la unica secuencia que no puede dejar basura permanente:
 *
 *   - unlink OK     -> el archivo ya no esta -> la fila se puede borrar.
 *   - unlink ENOENT -> el archivo ya no estaba (purga anterior a medias, o un
 *                      restore incompleto) -> la fila se puede borrar.
 *   - unlink falla  -> el archivo SIGUE ahi -> la fila se CONSERVA.
 *
 * En los tres casos vale la misma invariante: nunca una fila sin archivo, nunca
 * un archivo sin fila. Un fallo de disco atrasa la purga de esa foto hasta la
 * proxima pasada, que es exactamente lo que uno quiere que pase.
 *
 * Al reves —fila primero— un fallo de disco deja un huerfano que ninguna pasada
 * posterior puede encontrar, porque la fila que decia donde estaba ya no existe.
 *
 * UN ARCHIVO QUE FALLA NO CORTA EL LOTE. Las fotos que vienen detras pueden ser
 * de otra ronda o de otra empresa y no tienen la culpa.
 */

/** Una foto vencida, tal como la devuelve `retencion_fotos_vencidas`. */
export interface FotoVencida {
  readonly fotoId: string;
  readonly rutaRelativa: string;
}

export interface ResultadoDeDisco {
  /** Ids cuyo archivo ya no esta: son los unicos que se mandan a borrar. */
  readonly borrables: string[];
  /**
   * Ids de las fotos que CONSERVAN su fila porque su archivo no se pudo borrar.
   *
   * Son ids y no un conteo, y no es un detalle: la consulta devuelve siempre las
   * mas viejas primero, asi que una foto trabada vuelve a salir la primera en
   * cada lote de la pasada. Con un conteo, quien llama no puede distinguir "diez
   * archivos rotos" de "un archivo roto contado diez veces", que es el numero
   * con el que el operador decide si el volumen esta roto — ni puede pedirle al
   * lote siguiente que la saltee.
   *
   * Siguen sin viajar las RUTAS: el path lleva adentro el tenant y la ronda, y
   * el log de este producto no arrastra ubicaciones de personas. Un uuid no dice
   * donde estuvo nadie.
   */
  readonly conservadas: string[];
  /** Motivos distintos que aparecieron, para que el log diga algo accionable. */
  readonly motivos: string[];
}

/**
 * Ruta absoluta de una foto, o null si se escaparia del volumen.
 *
 * `storage_path` lo escribe la API y no el cliente, pero esta funcion BORRA: una
 * fila con `..` adentro —por un bug futuro, por un restore manipulado o por una
 * migracion de datos mal hecha— seria un borrado arbitrario de archivos del
 * servidor con los permisos del proceso. El mismo chequeo que hace
 * photo-serving.service.ts para leer, aca para destruir.
 */
export function rutaDeEvidencia(base: string, rutaRelativa: string): string | null {
  const absoluta = join(base, rutaRelativa);
  return normalize(absoluta).startsWith(normalize(base) + sep) ? absoluta : null;
}

/**
 * Borra del volumen los archivos de las fotos dadas y devuelve cuales quedaron
 * en condiciones de que se les borre la fila.
 */
export async function borrarEvidenciaDeDisco(
  base: string,
  fotos: readonly FotoVencida[],
): Promise<ResultadoDeDisco> {
  const borrables: string[] = [];
  // Set y no arreglo: la longitud de esta lista es "cuantos archivos estan
  // trabados", el numero con el que se decide si el volumen esta roto. Un id
  // contado dos veces ya inflo ese numero una vez y no lo va a volver a hacer.
  const conservadas = new Set<string>();
  const motivos = new Set<string>();
  const carpetas = new Set<string>();

  for (const foto of fotos) {
    const absoluta = rutaDeEvidencia(base, foto.rutaRelativa);
    if (absoluta === null) {
      // No se borra el archivo (esta fuera del volumen) y por lo tanto tampoco
      // la fila: dejarla sin archivo borrado seria perder el rastro justo del
      // caso mas sospechoso que hay.
      conservadas.add(foto.fotoId);
      motivos.add('ruta_fuera_del_volumen');
      continue;
    }

    try {
      // force: true trata "el archivo ya no esta" como exito, que es lo correcto
      // aca: el objetivo es que no exista, no haberlo borrado uno mismo.
      await rm(absoluta, { force: true });
      borrables.push(foto.fotoId);
      carpetas.add(dirname(absoluta));
    } catch (error) {
      conservadas.add(foto.fotoId);
      motivos.add(codigoDeError(error));
    }
  }

  await limpiarCarpetasVacias(base, carpetas);

  return { borrables, conservadas: [...conservadas], motivos: [...motivos] };
}

/**
 * Saca las carpetas que quedaron vacias.
 *
 * La evidencia se guarda en `<tenant>/<ronda>/` y `<tenant>/novedades/<id>/`:
 * una empresa con dos años de rondas deja decenas de miles de directorios
 * vacios si nadie los saca, y eso vuelve lentisimo cualquier recorrido del
 * volumen (empezando por el respaldo).
 *
 * Falla en silencio a proposito: si la carpeta no esta vacia —porque quedo una
 * foto que no se pudo borrar— rmdir lanza ENOTEMPTY y eso NO es un error, es la
 * respuesta correcta. Nunca se toca la raiz del volumen.
 */
async function limpiarCarpetasVacias(base: string, carpetas: Set<string>): Promise<void> {
  const raiz = normalize(base);
  for (const carpeta of carpetas) {
    if (normalize(carpeta) === raiz) continue;
    try {
      await rmdir(carpeta);
    } catch {
      // ENOTEMPTY / ENOENT / permisos: nada que hacer y nada que reportar.
    }
  }
}

function codigoDeError(error: unknown): string {
  const codigo = (error as { code?: unknown } | null)?.code;
  return typeof codigo === 'string' ? codigo : 'desconocido';
}
