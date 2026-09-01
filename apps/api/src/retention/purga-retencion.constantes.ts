/**
 * Los numeros del BARRIDO de la purga (#219).
 *
 * NINGUNO DE ESTOS ES UNA REGLA DE NEGOCIO, y por eso no van a rules.ts. Mismo
 * criterio que ENVIO_BARRIDO_INTERVALO_MS: no describen una politica que el
 * admin de una empresa quiera cambiar, describen cuanto trabajo se permite hacer
 * el sistema de una vez. Ningun jefe de operaciones pide "purgame de a 200
 * fotos"; pide que sus datos no se guarden mas alla del plazo, y ESE plazo si es
 * regla configurable (photoRetentionDays, gpsTrackRetentionDays).
 */

export const PURGA_RETENCION_QUEUE_NAME = 'retention-purge';
export const PURGA_RETENCION_JOB_NAME = 'purge';
export const PURGA_RETENCION_SCHEDULER_ID = 'retention-purge';

/**
 * Cada cuanto pasa el barrido.
 *
 * Seis horas y no una: la retencion se mide en dias, asi que barrer mas seguido
 * no borra antes nada, solo agrega pasadas vacias. Y no 24 horas porque los
 * topes por pasada son deliberadamente conservadores: cuatro pasadas al dia le
 * dan al sistema como drenar un atraso grande —el primer despliegue de esto en
 * una base de un año— sin una sola pasada que tome la base por horas.
 */
export const PURGA_INTERVALO_MS = 6 * 60 * 60_000;

/**
 * Techo de empresas por pasada.
 *
 * NO es un limite del producto y NO deja empresas afuera para siempre: lo que
 * no entra en esta pasada entra en la siguiente, porque `retencion_tenants`
 * ordena por la marca de ultimo barrido y no por id. Con N empresas y este
 * techo T, ninguna espera mas de ceil(N/T) pasadas.
 *
 * La version anterior de este carril ordenaba por `empresa.id`, y entonces este
 * numero SI era un limite del producto: con 501 empresas, la 501 no se purgaba
 * jamas y el log decia `{"tenants":500}` todas las veces. Ver el comentario de
 * `retencion_tenants` en la migracion.
 */
export const PURGA_MAX_TENANTS = 500;

/**
 * Fotos por transaccion. Cada lote implica borrar ese numero de archivos del
 * volumen antes de tocar la base, asi que el lote es tambien cuanto trabajo se
 * pierde si el proceso muere a la mitad.
 */
export const PURGA_LOTE_FOTOS = 200;

/** Tope de fotos por empresa y por pasada. Con 4 pasadas al dia son 8000/dia. */
export const PURGA_MAX_FOTOS_POR_TENANT = 2_000;

/**
 * Cuantos archivos TRABADOS se toleran por empresa y conjunto antes de dejar el
 * resto para la proxima pasada.
 *
 * Una foto cuyo archivo no se pudo borrar conserva su fila, asi que el barrido
 * la arrastra en la lista de exclusion durante toda la pasada. Ese arrastre es
 * lo que impide que tape a las que vienen detras —el bug que este numero
 * acompaña— pero tiene un costo: la lista viaja como parametro en cada lote.
 *
 * Pasado este punto ya no es un archivo con permisos raros, es el volumen roto:
 * insistir no va a borrar mas y el log ya aviso. Se corta y se reintenta en la
 * proxima pasada.
 */
export const PURGA_MAX_TRABADAS_POR_TENANT = 500;

/**
 * Filas de traza por transaccion. Mucho mas alto que el de fotos porque no hay
 * archivos de por medio: es un DELETE por indice y nada mas.
 */
export const PURGA_LOTE_TRAZAS = 5_000;

/** Tope de traza por empresa y por pasada. Un turno de 8 h son ~960 filas. */
export const PURGA_MAX_TRAZAS_POR_TENANT = 100_000;
