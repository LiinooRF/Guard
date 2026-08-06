/**
 * Barrido del aviso de inicio de ronda (#43).
 *
 * NINGUNO DE ESTOS NUMEROS ES UNA REGLA DE NEGOCIO, y por eso no van a rules.ts
 * —mismo criterio que ENVIO_BARRIDO_INTERVALO_MS—: no describen una politica que
 * el jefe de operaciones de una empresa quiera cambiar, describen cada cuanto se
 * despierta el proceso y cuanto aguanta de una vez. El unico parametro de negocio
 * de este carril es `patrolStartNoticeMin` (cuanta anticipacion quiere cada
 * empresa), y ese SI vive en el catalogo de reglas.
 */

export const AVISO_INICIO_QUEUE_NAME = 'patrol-start-notice';
export const AVISO_INICIO_JOB_NAME = 'sweep';
export const AVISO_INICIO_SCHEDULER_ID = 'patrol-start-notice';

/**
 * Cada cuanto pasa el barrido.
 *
 * Es el error maximo del aviso: con dos minutos, una empresa que pide avisar 10
 * minutos antes recibe el aviso entre 10 y 8 minutos antes. Bajarlo no mejora
 * nada que se note en terreno y sube la carga; subirlo mucho lo volveria
 * impreciso justo donde importa —una anticipacion de 5 minutos con un barrido de
 * 10 avisaria tarde la mitad de las veces—.
 */
export const AVISO_INICIO_INTERVALO_MS = 2 * 60_000;

/**
 * Techo de anticipacion que mira la consulta cruza-empresas.
 *
 * TIENE QUE SER IGUAL AL MAXIMO DE `patrolStartNoticeMin` en rules.ts. El
 * barrido no puede leer la regla de cada empresa —corre sin tenant—, asi que
 * trae a todas las rondas que empiezan dentro del techo y recien adentro de la
 * transaccion de cada empresa decide si ya toca avisar. Si este numero quedara
 * por debajo del maximo del catalogo, la empresa que configure la anticipacion
 * mas larga no recibiria el aviso nunca, y el sintoma seria "a nosotros no nos
 * llega" sin ningun error en ningun log.
 */
export const AVISO_INICIO_MAX_ANTICIPACION_MIN = 120;

/**
 * Rondas por pasada. Es un techo de seguridad, no una cuota: en un cambio de
 * turno arrancan muchas rondas juntas, pero repartidas entre las empresas del
 * SaaS. Si alguna vez se llegara al tope, lo que queda afuera entra en la pasada
 * siguiente —dos minutos despues— y la ventana de anticipacion da de sobra.
 */
export const AVISO_INICIO_MAX_RONDAS = 500;

/**
 * Prefijo de la clave de idempotencia del push. Identifica el HECHO ("a esta
 * ronda ya se le aviso"), no el intento: PushService le agrega el destinatario y
 * lo hashea, y BullMQ descarta el repetido. Es lo que hace que las sucesivas
 * pasadas del barrido dentro de la misma ventana no vuelvan a sonar.
 */
export const AVISO_INICIO_CLAVE = 'patrol-start';
