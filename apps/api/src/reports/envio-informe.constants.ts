/**
 * Cola del envio automatico del informe al cierre de la ronda (#86).
 *
 * Es una cola PROPIA y no la de correo porque lo que hace el worker no es
 * mandar un mail: abre transaccion con contexto de tenant, consulta la ronda
 * completa y DIBUJA un PDF. Eso son cientos de milisegundos y varias consultas,
 * y no puede ocurrir dentro del request del escaneo: el guardia esta en terreno,
 * muchas veces con una barra de señal, y su escaneo tiene que responder ya.
 * Cuando el PDF esta listo, este worker delega el envio en la cola de correo,
 * que sigue siendo la unica que habla con SMTP.
 */
export const ENVIO_INFORME_QUEUE_NAME = 'report-dispatch';
export const ENVIO_INFORME_JOB_NAME = 'dispatch';

/**
 * Reintentos y espera del job.
 *
 * NO son parametros de negocio y por eso no van a rules.ts: no describen una
 * politica que el admin quiera cambiar, describen cuanto aguanta el sistema una
 * caida de la base o del disco de evidencia. El arranque es mas largo que el del
 * correo (1 s) a proposito: el caso tipico de fallo aca es que el job llegue un
 * instante antes de que se confirme el cierre de la ronda, y para eso lo que
 * sirve es esperar, no reintentar rapido. Cinco intentos desde 5 s cubren mas de
 * un minuto de desfase.
 */
export const ENVIO_INFORME_JOB_ATTEMPTS = 5;
export const ENVIO_INFORME_JOB_BACKOFF_MS = 5_000;
