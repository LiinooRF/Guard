/** Cliente Redis del indice de correlacion. Ver registro-envios.correlacion.ts. */
export const REGISTRO_CORRELACION_REDIS = Symbol('REGISTRO_CORRELACION_REDIS');

/**
 * Prefijo de las llaves del indice Message-ID -> tenant. Namespace propio para
 * que un `KEYS sentrycore:notif:*` de soporte no toque sesiones ni colas.
 */
export const CORRELACION_PREFIJO = 'sentrycore:notif:msg:';

/**
 * Cuanto vive una correlacion. Un rebote diferido puede tardar dias —el servidor
 * del destinatario reintenta antes de rendirse— pero no meses. 30 dias cubre de
 * sobra el peor caso real sin dejar el indice creciendo para siempre.
 *
 * NO es una regla de negocio y por eso no vive en rules.ts: no cambia lo que el
 * producto hace, solo cuanto tiempo se puede correlacionar un webhook atrasado.
 * Si operaciones necesita moverlo, va como variable de entorno.
 */
export const CORRELACION_TTL_SEGUNDOS = 30 * 24 * 60 * 60;

/**
 * Ventana de frescura de la firma del webhook, en segundos. Una peticion firmada
 * hace mas de esto no se acepta aunque la firma calce: acota la reutilizacion de
 * una peticion capturada.
 */
export const WEBHOOK_VENTANA_SEGUNDOS = 300;

/** Secreto compartido con el traductor del proveedor. Ver INTEGRACION.md. */
export const WEBHOOK_SECRET_ENV = 'NOTIF_WEBHOOK_SECRET';

/** Filas por pagina en la vista de soporte. */
export const REGISTRO_LIMITE_DEFECTO = 50;
export const REGISTRO_LIMITE_MAXIMO = 200;

/**
 * Largo maximo del motivo de fallo que se guarda. Espejo del CHECK de
 * mail_deliveries.last_error (<= 300): recortar aca evita que un rebote SMTP
 * largo haga fallar el UPDATE y pierda el estado entero.
 */
export const MOTIVO_MAX_LARGO = 300;

/** Plantilla que se registra cuando no se puede deducir ninguna. */
export const PLANTILLA_DESCONOCIDA = 'sin-clasificar';
