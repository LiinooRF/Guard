/**
 * Vista de envios de correo para soporte (#221) — tipos y calculo puro.
 *
 * Mismo reparto que `auditoria-datos.ts` y `stats-charts-data.ts`: aca no hay
 * React ni fetch. Vive lo que se puede equivocar de verdad y probar con Jest sin
 * navegador ni base — sobre todo la traduccion del rebote, que es el corazon del
 * issue: soporte tiene que leer «la direccion no existe» y no `550 5.1.1`.
 *
 * DE DONDE SALE LA FORMA DE LOS DATOS
 * De `apps/api/src/mail/registro-envios.service.ts` (`listar` y `porRonda`),
 * cotejada contra la migracion `1725559220000-CreateMailDeliveries.ts`, que es
 * la que manda. Las columnas que existen son exactamente estas: id, tenant_id,
 * template_key, recipient_email, recipient_user_id, patrol_id, job_id,
 * provider_message_id, status, attempts, last_error, queued_at, sent_at,
 * delivered_at, failed_at. `job_id` y `provider_message_id` NO se exponen en la
 * respuesta y por eso no aparecen aca.
 *
 * LOS INSTANTES LLEGAN COMO TEXTO, NO COMO Date. `EnvioRegistrado` en la API los
 * declara `Date` porque ahi salen del driver de PostgreSQL; en el navegador —y
 * en el Server Component, que tambien lee JSON— ya pasaron por `JSON.stringify`
 * y son cadenas ISO. Declararlos `Date` aca haria que `.getTime()` compilara y
 * reventara en ejecucion.
 */

import { esDiaCalendario } from './auditoria-datos';

/* ------------------------------------------------------------------ */
/* Respuesta de la API                                                 */
/* ------------------------------------------------------------------ */

/** Una fila de `GET /notif/envios` o de `GET /notif/rondas/:id/envios`. */
export interface EnvioRegistrado {
  readonly id: string;
  /** Clave de catalogo de la plantilla, en minusculas. Nunca el asunto. */
  readonly plantilla: string;
  readonly destinatario: string;
  readonly destinatarioUsuarioId: string | null;
  readonly patrolId: string | null;
  readonly estado: string;
  readonly intentos: number;
  /** Motivo del ultimo fallo, ya saneado y recortado por el servidor. */
  readonly ultimoError: string | null;
  /** Instantes ISO. Ver el encabezado: son texto, no `Date`. */
  readonly encoladoEn: string;
  readonly enviadoEn: string | null;
  readonly entregadoEn: string | null;
  readonly falladoEn: string | null;
}

/** Lo que devuelve `GET /notif/rondas/:patrolId/envios`. */
export interface EnviosDeRonda {
  readonly patrolId: string;
  readonly envios: EnvioRegistrado[];
}

/**
 * Una ronda conocida por la pagina, para el selector.
 *
 * Es la forma de `overview.patrols` (`GET /dashboard/tenant`), que la pagina ya
 * carga para las tarjetas y para los informes. Se declara aca —y no se importa
 * de `informes-panel.tsx`— para no atar un componente de servidor a un modulo
 * `'use client'`.
 *
 * TRAE COMO MUCHO CINCO RONDAS: `DashboardService` cierra esa consulta con
 * `LIMIT 5`. No es el catalogo de rondas de la empresa, y por eso el filtro
 * acepta ademas un id pegado a mano; ver `resolverFiltro`.
 */
export interface RondaConocida {
  readonly id: string;
  readonly siteName: string;
  readonly routeName: string;
  readonly status: string;
  readonly scheduledStartAt: string;
}

/** Un recinto, tal como lo devuelve `GET /admin/sites`. */
export interface RecintoConocido {
  readonly id: string;
  readonly name: string;
  readonly branchName: string;
  /** `sites.timezone`. Es la zona en la que la API lee `desde` y `hasta`. */
  readonly timezone: string;
  readonly isActive: boolean;
}

/* ------------------------------------------------------------------ */
/* Estados del envio                                                   */
/* ------------------------------------------------------------------ */

/**
 * Espejo EXACTO del CHECK de `mail_deliveries.status` y de `ESTADOS_ENVIO` en
 * `apps/api/src/mail/registro-envios.types.ts`.
 *
 * Esta duplicado y no importado porque el panel no puede importar de `apps/api`:
 * lo compartido vive en `packages/shared`, y estos estados todavia no estan ahi.
 * Mientras sigan duplicados, una lista que se quede corta NO rompe la pantalla
 * —`describirEstado` arma una ficha legible para lo que no conoce— pero si deja
 * el estado nuevo fuera del selector. Moverlos a `@voxia/shared` esta propuesto
 * en INTEGRACION.md.
 */
export const ESTADOS_ENVIO = [
  'encolado',
  'enviado',
  'entregado',
  'rebotado',
  'reclamo',
  'fallido',
] as const;
export type EstadoEnvio = (typeof ESTADOS_ENVIO)[number];

export function esEstadoConocido(valor: string | undefined | null): valor is EstadoEnvio {
  return typeof valor === 'string' && (ESTADOS_ENVIO as readonly string[]).includes(valor);
}

export type TonoEstado = 'ok' | 'espera' | 'alerta';

export interface FichaEstado {
  readonly clave: string;
  /** Como se lee en pantalla, respondiendo la pregunta de operaciones. */
  readonly etiqueta: string;
  /** Que significa exactamente, sin saber que es SMTP. */
  readonly explicacion: string;
  readonly tono: TonoEstado;
  /** Si el correo salio de nuestro servidor hacia el del destinatario. */
  readonly salio: boolean;
  /**
   * Si llego al buzon. `null` es «no se sabe», y es distinto de `false`.
   *
   * 'enviado' vale `null` a proposito: que el relay SMTP acepte el mensaje solo
   * dice que se hizo cargo de intentarlo. Pintarlo como entregado seria
   * exactamente la respuesta comoda y falsa que esta pantalla existe para no
   * dar.
   */
  readonly llego: boolean | null;
}

export const CATALOGO_ESTADOS: Record<EstadoEnvio, FichaEstado> = {
  encolado: {
    clave: 'encolado',
    etiqueta: 'En cola',
    explicacion: 'El sistema lo aceptó y todavía no sale. Suele durar segundos.',
    tono: 'espera',
    salio: false,
    llego: null,
  },
  enviado: {
    clave: 'enviado',
    etiqueta: 'Salió',
    explicacion:
      'Nuestro servidor se lo entregó al del destinatario y quedó aceptado. Todavía no hay confirmación de que haya entrado al buzón.',
    tono: 'espera',
    salio: true,
    llego: null,
  },
  entregado: {
    clave: 'entregado',
    etiqueta: 'Llegó',
    explicacion: 'El proveedor de correo confirmó que entró al buzón del destinatario.',
    tono: 'ok',
    salio: true,
    llego: true,
  },
  rebotado: {
    clave: 'rebotado',
    etiqueta: 'Rebotó',
    explicacion: 'El servidor del destinatario lo rechazó y devolvió el motivo.',
    tono: 'alerta',
    salio: true,
    llego: false,
  },
  reclamo: {
    clave: 'reclamo',
    etiqueta: 'Marcado como no deseado',
    explicacion:
      'Llegó, pero el destinatario lo marcó como correo no deseado. Los siguientes pueden terminar en su carpeta de spam.',
    tono: 'alerta',
    salio: true,
    llego: true,
  },
  fallido: {
    clave: 'fallido',
    etiqueta: 'No se pudo enviar',
    explicacion: 'Se agotaron los reintentos sin que ningún servidor se hiciera cargo del correo.',
    tono: 'alerta',
    salio: false,
    llego: false,
  },
};

/**
 * Ficha de un estado, inventando una legible cuando no esta en el catalogo.
 *
 * Un estado desconocido NO se esconde ni se pinta como si fuera bueno: si el
 * backend empieza a escribir uno nuevo, soporte tiene que verlo. Se marca como
 * alerta y con «no se sabe» en la entrega, que es lo unico honesto.
 */
export function describirEstado(estado: string): FichaEstado {
  if (esEstadoConocido(estado)) return CATALOGO_ESTADOS[estado];
  return {
    clave: estado,
    etiqueta: estado,
    explicacion: 'Estado que esta pantalla todavía no sabe describir. El registro es válido igual.',
    tono: 'alerta',
    salio: false,
    llego: null,
  };
}

/* ------------------------------------------------------------------ */
/* Plantillas                                                          */
/* ------------------------------------------------------------------ */

export interface FichaPlantilla {
  readonly clave: string;
  readonly etiqueta: string;
  readonly cuando: string;
}

/**
 * Que correo es cada clave.
 *
 * SON DOS FAMILIAS DE CLAVES Y LAS DOS EXISTEN, por como el servidor decide el
 * `template_key` (ver `registro-envios.service.ts`):
 *
 *  1. La que declara quien encola (`EnqueueMailOptions.registro.plantilla`), que
 *     usa las claves del catalogo de plantillas de la API: 'informe-ronda',
 *     'alerta-cumplimiento', 'invitacion', 'recuperacion'.
 *  2. La DEDUCIDA de la clave de idempotencia por `plantillaDesdeClave()`, que
 *     toma como mucho dos segmentos: 'report-dispatch:informe',
 *     'report-dispatch:alerta', 'escalation', 'false-alarm', 'patrol-alert',
 *     'checklist-fail', 'invitation', 'password-reset'.
 *
 * Las dos estan en el catalogo porque hoy NADIE declara la suya —ningun
 * `enqueue` pasa `registro`— y todo lo que se registre va a llegar deducido; en
 * cuanto alguien declare la primera, la vista tiene que seguir leyendose. Lo que
 * no este mapeado se muestra igual, humanizado y con la clave cruda al lado.
 */
export const CATALOGO_PLANTILLAS: readonly FichaPlantilla[] = [
  {
    clave: 'report-dispatch:informe',
    etiqueta: 'Informe de ronda',
    cuando: 'Al cerrarse la ronda, con el informe en PDF adjunto.',
  },
  {
    clave: 'report-dispatch:alerta',
    etiqueta: 'Alerta de cumplimiento',
    cuando: 'Cuando la ronda cerró bajo el mínimo configurado.',
  },
  {
    clave: 'informe-ronda',
    etiqueta: 'Informe de ronda',
    cuando: 'Al cerrarse la ronda, con el informe en PDF adjunto.',
  },
  {
    clave: 'alerta-cumplimiento',
    etiqueta: 'Alerta de cumplimiento',
    cuando: 'Cuando la ronda cerró bajo el mínimo configurado.',
  },
  {
    clave: 'patrol-alert',
    etiqueta: 'Aviso de ronda',
    cuando: 'Ronda vencida, atrasada o con una anomalía.',
  },
  {
    clave: 'escalation',
    etiqueta: 'Escalamiento de novedad',
    cuando: 'Cuando una novedad crítica sube por la cadena de avisos.',
  },
  {
    clave: 'false-alarm',
    etiqueta: 'Aviso de falsa alarma',
    cuando: 'Cuando se corrige un pánico que resultó ser falsa alarma.',
  },
  {
    clave: 'checklist-fail',
    etiqueta: 'Falla de checklist',
    cuando: 'Cuando el guardia marca una falla en la lista de verificación.',
  },
  {
    clave: 'invitation',
    etiqueta: 'Invitación de usuario',
    cuando: 'Al crear una cuenta con correo, para que defina su contraseña.',
  },
  {
    clave: 'invitacion',
    etiqueta: 'Invitación de usuario',
    cuando: 'Al crear una cuenta con correo, para que defina su contraseña.',
  },
  {
    clave: 'password-reset',
    etiqueta: 'Recuperación de contraseña',
    cuando: 'Cuando alguien la pide desde la pantalla de ingreso.',
  },
  {
    clave: 'recuperacion',
    etiqueta: 'Recuperación de contraseña',
    cuando: 'Cuando alguien la pide desde la pantalla de ingreso.',
  },
  {
    clave: 'sin-clasificar',
    etiqueta: 'Sin clasificar',
    cuando:
      'El correo salió, pero el sistema no pudo deducir de qué tipo era. Se registra igual: es preferible a no registrarlo.',
  },
];

const PLANTILLA_POR_CLAVE = new Map<string, FichaPlantilla>(
  CATALOGO_PLANTILLAS.map((ficha) => [ficha.clave, ficha]),
);

function capitalizar(texto: string): string {
  return texto.length ? `${texto[0]?.toUpperCase() ?? ''}${texto.slice(1)}` : texto;
}

/** Ficha de una plantilla, humanizando la clave cuando no esta en el catalogo. */
export function describirPlantilla(clave: string): FichaPlantilla {
  const conocida = PLANTILLA_POR_CLAVE.get(clave);
  if (conocida) return conocida;

  const legible = clave.replace(/[:_-]+/g, ' ').trim();
  return {
    clave,
    etiqueta: legible.length ? capitalizar(legible) : clave,
    cuando: 'Tipo de correo que esta pantalla todavía no sabe describir.',
  };
}

/**
 * Opciones del selector de plantilla: el catalogo MAS lo que ya aparece en los
 * datos de la empresa. Sin lo segundo, un tipo de correo nuevo del backend no se
 * podria filtrar; sin lo primero, uno que todavia no se ha enviado nunca no
 * aparece y da la impresion de que no existe.
 */
export function opcionesDePlantilla(presentes: readonly string[]): FichaPlantilla[] {
  const vistas = new Set<string>();
  const opciones: FichaPlantilla[] = [];
  for (const ficha of CATALOGO_PLANTILLAS) {
    // El catalogo tiene dos claves distintas con la misma etiqueta
    // ('invitation' e 'invitacion'): son dos valores reales de la columna y el
    // filtro manda la clave, asi que las dos tienen que poder elegirse.
    if (vistas.has(ficha.clave)) continue;
    vistas.add(ficha.clave);
    opciones.push(ficha);
  }
  for (const clave of presentes) {
    if (vistas.has(clave)) continue;
    vistas.add(clave);
    opciones.push(describirPlantilla(clave));
  }
  return opciones;
}

/* ------------------------------------------------------------------ */
/* Traduccion del rebote                                               */
/* ------------------------------------------------------------------ */

export type CausaFalla =
  | 'direccion'
  | 'dominio'
  | 'casilla-llena'
  | 'casilla-cerrada'
  | 'tamano'
  | 'rechazo'
  | 'conexion'
  | 'configuracion'
  | 'temporal'
  | 'reclamo'
  | 'desconocida';

export interface MotivoLegible {
  readonly causa: CausaFalla;
  /** Una linea, en lenguaje del jefe de operaciones. */
  readonly titulo: string;
  /** Que conviene hacer. Nunca «revise los logs». */
  readonly queHacer: string;
  /**
   * `true` si el servidor del destinatario contesto con un codigo de la clase 4,
   * que en SMTP significa «ahora no, prueba mas tarde».
   */
  readonly transitorio: boolean;
  /** El texto crudo del servidor. Va escondido en pantalla, nunca en un log. */
  readonly tecnico: string | null;
}

interface Traduccion {
  readonly causa: CausaFalla;
  readonly titulo: string;
  readonly queHacer: string;
}

const TRADUCCIONES: Record<CausaFalla, Traduccion> = {
  direccion: {
    causa: 'direccion',
    titulo: 'La dirección no existe',
    queHacer:
      'Revisa cómo está escrito el correo en la ficha del usuario o en los destinatarios de informes del recinto. Mientras esté mal, ningún reenvío va a llegar.',
  },
  dominio: {
    causa: 'dominio',
    titulo: 'El dominio del correo no existe o no recibe correo',
    queHacer:
      'Lo que está después del @ no responde. Suele ser un error de tipeo en el dominio, o una empresa que cambió de proveedor.',
  },
  'casilla-llena': {
    causa: 'casilla-llena',
    titulo: 'La casilla del destinatario está llena',
    queHacer:
      'Es del lado del cliente: tiene que hacer espacio. Avísale por otra vía y vuelve a mandarlo cuando lo confirme.',
  },
  'casilla-cerrada': {
    causa: 'casilla-cerrada',
    titulo: 'La casilla está deshabilitada o ya no se usa',
    queHacer:
      'Es una cuenta que existió y hoy no recibe. Pídele al cliente una dirección vigente y cámbiala en la configuración.',
  },
  tamano: {
    causa: 'tamano',
    titulo: 'El correo pesaba más de lo que acepta el destinatario',
    queHacer:
      'Pasa con informes de rondas con muchas fotos. El destinatario puede subir su límite, o se despacha el informe sin el anexo fotográfico.',
  },
  rechazo: {
    causa: 'rechazo',
    titulo: 'El servidor del destinatario lo rechazó por sus reglas antispam',
    queHacer:
      'No es un problema de la dirección. Pídele al cliente que ponga nuestro remitente en su lista de confianza; si se repite, hay que revisar la configuración del dominio de envío.',
  },
  conexion: {
    causa: 'conexion',
    titulo: 'No se pudo conectar con el servidor de correo',
    queHacer:
      'Es un problema de red entre los dos servidores. Casi siempre se resuelve solo; si se repite en todos los envíos, avisa al equipo técnico.',
  },
  configuracion: {
    causa: 'configuracion',
    titulo: 'Nuestro servidor de correo rechazó la cuenta de envío',
    queHacer:
      'Esto es nuestro, no del cliente: la clave o el remitente configurados para enviar no están sirviendo. Avisa al equipo técnico, no al cliente.',
  },
  temporal: {
    causa: 'temporal',
    titulo: 'El servidor del destinatario pidió esperar',
    queHacer:
      'Es un rechazo temporal, y muchas veces se resuelve solo en el siguiente intento. Vuelve a mirar esta pantalla en un rato.',
  },
  reclamo: {
    causa: 'reclamo',
    titulo: 'El destinatario lo marcó como correo no deseado',
    queHacer:
      'El correo llegó. Conviene hablar con el cliente: mientras siga marcado así, los próximos pueden ir directo a su carpeta de spam.',
  },
  desconocida: {
    causa: 'desconocida',
    titulo: 'El envío falló y el servidor no explicó por qué',
    queHacer:
      'Abajo está el texto tal como lo devolvió el servidor. Si no se entiende, pásalo al equipo técnico con la fecha y el destinatario.',
  },
};

/**
 * Codigo ampliado de SMTP (RFC 3463), por «asunto.detalle».
 *
 * La CLASE (el primer digito) dice si es permanente (5) o temporal (4), y los
 * otros dos dicen QUE paso. Se traduce por asunto.detalle y la clase se usa solo
 * para marcar `transitorio` y como ultimo recurso: un `4.2.2` que llego como
 * rebote es una casilla llena que ya no se reintenta mas, y decir «espera un
 * rato» ahi seria mandar a soporte a esperar algo que no va a pasar.
 */
const POR_CODIGO_AMPLIADO: Record<string, CausaFalla> = {
  '1.1': 'direccion',
  '1.2': 'dominio',
  '1.3': 'direccion',
  '1.6': 'direccion',
  '1.10': 'dominio',
  '2.1': 'casilla-cerrada',
  '2.2': 'casilla-llena',
  '2.3': 'tamano',
  '3.1': 'temporal',
  '3.4': 'tamano',
  '4.1': 'conexion',
  '4.2': 'conexion',
  '4.4': 'conexion',
  '4.5': 'conexion',
  '4.7': 'conexion',
  '7.0': 'rechazo',
  '7.1': 'rechazo',
  '7.8': 'configuracion',
  '7.9': 'configuracion',
  '7.26': 'rechazo',
};

/** Codigo clasico de tres digitos, cuando no vino el ampliado. */
const POR_CODIGO_BASICO: Record<string, CausaFalla> = {
  '421': 'conexion',
  '450': 'temporal',
  '451': 'temporal',
  '452': 'temporal',
  '454': 'configuracion',
  '535': 'configuracion',
  '550': 'direccion',
  '551': 'direccion',
  '552': 'tamano',
  '553': 'direccion',
  '554': 'rechazo',
};

/**
 * Texto del rebote, para cuando el servidor no manda ningun codigo.
 *
 * El orden importa: gana el primero que calza, asi que lo especifico va antes
 * que lo generico ('mailbox full' antes que 'mailbox').
 */
const POR_TEXTO: ReadonlyArray<{ patron: RegExp; causa: CausaFalla }> = [
  { patron: /(mailbox|casilla)\s+(is\s+)?full|over\s*quota|quota\s+exceeded|insufficient\s+storage/i, causa: 'casilla-llena' },
  { patron: /user\s+unknown|no\s+such\s+(user|recipient)|unknown\s+(user|recipient)|recipient\s+(address\s+)?rejected|address\s+rejected|invalid\s+recipient|mailbox\s+(not\s+found|unavailable|does\s+not\s+exist)|does\s+not\s+exist|dirección\s+no\s+existe/i, causa: 'direccion' },
  { patron: /account\s+(is\s+)?(disabled|inactive|closed|suspended)|mailbox\s+disabled|no\s+longer\s+in\s+use/i, causa: 'casilla-cerrada' },
  { patron: /(domain|host)\s+not\s+found|host\s+unknown|unrouteable|unroutable|nxdomain|enotfound|getaddrinfo|no\s+mx\b|null\s+mx/i, causa: 'dominio' },
  { patron: /invalid\s+login|authentication\s+(failed|required|unsuccessful)|auth\s+failed|bad\s+credentials|username\s+and\s+password\s+not\s+accepted/i, causa: 'configuracion' },
  { patron: /spam|blocked|block\s*list|blacklist|denylist|reputation|policy\s+(reasons|violation)|spf|dkim|dmarc|greylist/i, causa: 'rechazo' },
  { patron: /(message|size)\s+too\s+(large|big)|size\s+(limit\s+)?exceed|exceeds\s+(the\s+)?(maximum|size)/i, causa: 'tamano' },
  { patron: /timed?\s*out|etimedout|econnrefused|econnreset|ehostunreach|enetunreach|epipe|socket\s+(hang|close)|connection\s+(refused|closed|error|lost)|network/i, causa: 'conexion' },
  { patron: /try\s+again\s+later|temporar|deferred|resources\s+temporarily/i, causa: 'temporal' },
];

const CODIGO_AMPLIADO = /\b([245])\.(\d{1,3})\.(\d{1,3})\b/;
const CODIGO_BASICO = /\b([45]\d{2})\b/;

/**
 * Que le paso a este correo, en lenguaje entendible.
 *
 * Devuelve `null` cuando no hay nada que explicar: el envio va bien o ya llego.
 * Un correo entregado que en el camino tuvo un tropiezo no muestra el error
 * viejo; lo que importa es que llego.
 *
 * `estado` se recibe como `string` y no como `EstadoEnvio` porque viene de la
 * API: un estado nuevo del backend no puede reventar la pantalla.
 */
export function explicarMotivo(estado: string, ultimoError: string | null): MotivoLegible | null {
  const tecnico = ultimoError !== null && ultimoError.trim().length > 0 ? ultimoError.trim() : null;

  if (estado === 'reclamo') {
    return { ...TRADUCCIONES.reclamo, transitorio: false, tecnico };
  }
  if (estado === 'entregado' || estado === 'enviado') return null;
  if (estado === 'encolado' && tecnico === null) return null;

  if (tecnico === null) {
    if (estado !== 'rebotado' && estado !== 'fallido') return null;
    return { ...TRADUCCIONES.desconocida, transitorio: false, tecnico: null };
  }

  const ampliado = CODIGO_AMPLIADO.exec(tecnico);
  const clase = ampliado?.[1] ?? null;
  const transitorio = clase === '4';

  const porAmpliado = ampliado ? POR_CODIGO_AMPLIADO[`${ampliado[2]}.${ampliado[3]}`] : undefined;
  if (porAmpliado) return { ...TRADUCCIONES[porAmpliado], transitorio, tecnico };

  for (const { patron, causa } of POR_TEXTO) {
    if (patron.test(tecnico)) return { ...TRADUCCIONES[causa], transitorio, tecnico };
  }

  // El codigo clasico va al final: `550` cubre desde una casilla inexistente
  // hasta un rechazo por reputacion, asi que el texto del servidor —cuando dice
  // algo— es mas fiable que el numero.
  const basico = CODIGO_BASICO.exec(tecnico);
  const porBasico = basico?.[1] ? POR_CODIGO_BASICO[basico[1]] : undefined;
  if (porBasico) return { ...TRADUCCIONES[porBasico], transitorio, tecnico };

  if (transitorio) return { ...TRADUCCIONES.temporal, transitorio, tecnico };
  return { ...TRADUCCIONES.desconocida, transitorio, tecnico };
}

/* ------------------------------------------------------------------ */
/* Resumen                                                             */
/* ------------------------------------------------------------------ */

export interface ResumenEnvios {
  readonly total: number;
  /** Confirmados en el buzon del destinatario. */
  readonly entregados: number;
  /** Salieron y todavia no hay confirmacion de entrega. */
  readonly sinConfirmar: number;
  /** No llegaron: rebote o reintentos agotados. */
  readonly noLlegaron: number;
  /** Todavia en la cola. */
  readonly enCola: number;
  /** Marcados como no deseados por el destinatario. */
  readonly reclamos: number;
  /** Instante del envio mas reciente de la lista, o null. */
  readonly ultimo: string | null;
}

/**
 * Cifras de LO QUE SE ESTA VIENDO, no del periodo: `GET /notif/envios` no
 * devuelve un total y sumarlo por paginas contaria de mas. La pantalla dice cual
 * es cual en vez de dar por total lo que no lo es.
 */
export function resumirEnvios(envios: readonly EnvioRegistrado[]): ResumenEnvios {
  let entregados = 0;
  let sinConfirmar = 0;
  let noLlegaron = 0;
  let enCola = 0;
  let reclamos = 0;
  let ultimo: string | null = null;

  for (const envio of envios) {
    const ficha = describirEstado(envio.estado);
    if (envio.estado === 'reclamo') reclamos += 1;
    if (ficha.llego === true) entregados += 1;
    else if (ficha.llego === false) noLlegaron += 1;
    else if (ficha.salio) sinConfirmar += 1;
    else enCola += 1;

    if (ultimo === null || envio.encoladoEn > ultimo) ultimo = envio.encoladoEn;
  }

  return {
    total: envios.length,
    entregados,
    sinConfirmar,
    noLlegaron,
    enCola,
    reclamos,
    ultimo,
  };
}

/**
 * `true` si en lo que se esta viendo NINGUN envio tiene confirmacion de entrega
 * habiendo correos que ya salieron.
 *
 * Sirve para avisar en pantalla que la confirmacion de entrega la reporta el
 * proveedor de correo por webhook, y que mientras ese enganche no exista la
 * pregunta «¿le llego?» no se puede responder con un si. Se deduce de los datos
 * y no de una constante para que el aviso desaparezca solo el dia en que empiece
 * a llegar la primera confirmacion.
 */
export function faltaConfirmacionDeEntrega(resumen: ResumenEnvios): boolean {
  return resumen.entregados === 0 && resumen.reclamos === 0 && resumen.sinConfirmar > 0;
}

/** Las claves de plantilla presentes en los datos, para el selector. */
export function plantillasPresentes(envios: readonly EnvioRegistrado[]): string[] {
  const claves = new Set<string>();
  for (const envio of envios) claves.add(envio.plantilla);
  return [...claves].sort((a, b) => a.localeCompare(b, 'es'));
}

/** Las rondas presentes en los datos, para poder saltar a una desde el filtro. */
export function rondasPresentes(envios: readonly EnvioRegistrado[]): string[] {
  const ids = new Set<string>();
  for (const envio of envios) {
    if (envio.patrolId) ids.add(envio.patrolId);
  }
  return [...ids];
}

/* ------------------------------------------------------------------ */
/* Filtro                                                              */
/* ------------------------------------------------------------------ */

/**
 * Las claves de este panel en la URL, TODAS con prefijo `env_`.
 *
 * El prefijo no es cosmetico: en `app/app/[role]/page.tsx` conviven varios
 * bloques que leen los mismos `searchParams`. Los informes (#87) usan `desde`,
 * `hasta`, `recinto`, `sucursal` y `agrupacion`, y la auditoria (#104) usa
 * `aud_*`. Sin prefijo, elegir un periodo aca le cambiaria el periodo a los
 * informes y viceversa.
 *
 * EN LA URL NO VIAJA NINGUN CORREO. Solo ids y fechas: un enlace de esta
 * pantalla se pega en un ticket, y el destinatario es dato personal.
 */
export const CLAVE_URL = {
  recinto: 'env_recinto',
  estado: 'env_estado',
  plantilla: 'env_plantilla',
  desde: 'env_desde',
  hasta: 'env_hasta',
  ronda: 'env_ronda',
  filas: 'env_filas',
} as const;

export const CLAVES_URL_ENVIOS: readonly string[] = Object.values(CLAVE_URL);

/**
 * Cuantas filas puede pedir la pantalla.
 *
 * Espejo de `apps/api/src/mail/registro-envios.constants.ts`:
 * `REGISTRO_LIMITE_DEFECTO` es 50 y `REGISTRO_LIMITE_MAXIMO` es 200. Pedir mas
 * del maximo hace que el DTO responda 400 (`@Max(REGISTRO_LIMITE_MAXIMO)`), asi
 * que si ese tope baja, este arreglo baja con el. No es una regla de negocio
 * —no cambia lo que el producto hace, solo cuanto se lee de una vez— y por eso
 * no va a `rules.ts`.
 */
export const FILAS_DISPONIBLES = [50, 100, 200] as const;
export const FILAS_POR_DEFECTO = 50;

export interface FiltroEnvios {
  /** UUID del recinto, o cadena vacia. Obligatorio para filtrar por fechas. */
  readonly recinto: string;
  readonly estado: string;
  readonly plantilla: string;
  readonly desde: string;
  readonly hasta: string;
  /** UUID de la ronda. Si viene, manda sobre todo lo demas. */
  readonly ronda: string;
  readonly filas: number;
  /** `true` si lo que traia la URL no servia y hubo que corregirlo. */
  readonly ajustado: boolean;
  /**
   * `true` cuando habia fechas pero no recinto, y por eso se ignoraron.
   *
   * NO es un capricho de la pantalla: `RegistroEnviosService.listar()` responde
   * 400 si llegan fechas sin `siteId`, porque el periodo se interpreta en la
   * zona horaria del recinto. Mandarlas igual pintaria un error donde en verdad
   * falta elegir un dato.
   */
  readonly fechasIgnoradas: boolean;
}

export type ParametrosDePagina = Record<string, string | string[] | undefined>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function esUuid(valor: string | undefined | null): valor is string {
  return typeof valor === 'string' && UUID.test(valor);
}

function primerValor(valor: string | string[] | undefined): string | undefined {
  return Array.isArray(valor) ? valor[0] : valor;
}

/**
 * Todo lo que ya viaja en la URL y NO es de este panel. Se arrastra tal cual en
 * cada enlace: la pagina la comparten varios bloques y ninguno es dueño de la
 * query.
 */
/**
 * El recinto que pide la URL, antes de resolver el filtro completo.
 *
 * Existe por un orden que no se puede invertir: la zona horaria sale del recinto
 * elegido, `hoy` se calcula en esa zona y `resolverFiltro` necesita `hoy` para
 * recortar las fechas. Sin esta funcion el panel tendria que resolver el filtro
 * con una zona provisional y volver a resolverlo despues.
 */
export function recintoPedido(parametros: ParametrosDePagina): string {
  const valor = primerValor(parametros[CLAVE_URL.recinto]);
  return esUuid(valor) ? valor : '';
}

export function parametrosAjenos(parametros: ParametrosDePagina): URLSearchParams {
  const busqueda = new URLSearchParams();
  for (const [clave, valor] of Object.entries(parametros)) {
    if (CLAVES_URL_ENVIOS.includes(clave)) continue;
    if (valor === undefined) continue;
    if (Array.isArray(valor)) {
      for (const uno of valor) busqueda.append(clave, uno);
    } else {
      busqueda.set(clave, valor);
    }
  }
  return busqueda;
}

/**
 * Resuelve el filtro a partir de la URL.
 *
 * Nunca lanza: un enlace viejo o editado a mano tiene que abrir la pantalla
 * igual —con lo ultimo enviado y un aviso—, no con un error. La validacion dura
 * la sigue haciendo el servidor; esto es para que el jefe de operaciones no la
 * vea nunca.
 *
 * `hoy` llega calculado en el servidor, en la zona del recinto, para que la
 * hidratacion no dependa del reloj del navegador.
 */
export function resolverFiltro(parametros: ParametrosDePagina, hoy: string): FiltroEnvios {
  let ajustado = false;

  const crudo = {
    recinto: primerValor(parametros[CLAVE_URL.recinto]),
    estado: primerValor(parametros[CLAVE_URL.estado]),
    plantilla: primerValor(parametros[CLAVE_URL.plantilla]),
    desde: primerValor(parametros[CLAVE_URL.desde]),
    hasta: primerValor(parametros[CLAVE_URL.hasta]),
    ronda: primerValor(parametros[CLAVE_URL.ronda]),
    filas: primerValor(parametros[CLAVE_URL.filas]),
  };

  let ronda = '';
  if (esUuid(crudo.ronda)) ronda = crudo.ronda;
  else if (crudo.ronda) ajustado = true;

  let recinto = '';
  if (esUuid(crudo.recinto)) recinto = crudo.recinto;
  else if (crudo.recinto) ajustado = true;

  let estado = '';
  if (esEstadoConocido(crudo.estado)) estado = crudo.estado;
  else if (crudo.estado) ajustado = true;

  // La plantilla se acepta tal cual mientras calce con el CHECK de la columna:
  // el catalogo de esta pantalla es una foto y no puede decidir que claves
  // existen en la base.
  let plantilla = '';
  const plantillaLimpia = (crudo.plantilla ?? '').trim().toLowerCase();
  if (/^[a-z][a-z0-9:_-]{0,79}$/.test(plantillaLimpia)) plantilla = plantillaLimpia;
  else if (crudo.plantilla) ajustado = true;

  let desde = '';
  let hasta = '';
  if (esDiaCalendario(crudo.desde)) desde = crudo.desde;
  else if (crudo.desde) ajustado = true;
  if (esDiaCalendario(crudo.hasta)) hasta = crudo.hasta;
  else if (crudo.hasta) ajustado = true;

  // Un periodo al reves no devuelve nada y no se distingue de «no hubo envios».
  if (desde && hasta && desde > hasta) {
    hasta = '';
    ajustado = true;
  }
  // No hay envios de dias que todavia no ocurren.
  if (hasta && hasta > hoy) {
    hasta = hoy;
    ajustado = true;
  }
  if (desde && desde > hoy) {
    desde = hoy;
    ajustado = true;
  }

  let filas: number = FILAS_POR_DEFECTO;
  const pedidas = Number(crudo.filas);
  if ((FILAS_DISPONIBLES as readonly number[]).includes(pedidas)) filas = pedidas;
  else if (crudo.filas) ajustado = true;

  // Con una ronda elegida se contesta con el otro endpoint, que devuelve TODOS
  // sus correos y no admite filtros NI limite. Se limpian aca —y no solo en la
  // pantalla— para que lo que se ve y lo que se pidio no puedan discrepar: el
  // tamaño de pagina incluido, porque `GET /notif/rondas/:id/envios` lo ignora
  // y dejarlo en el selector prometeria un recorte que nadie aplica.
  if (ronda) {
    return {
      recinto: '',
      estado: '',
      plantilla: '',
      desde: '',
      hasta: '',
      ronda,
      filas: FILAS_POR_DEFECTO,
      ajustado,
      fechasIgnoradas: false,
    };
  }

  const fechasIgnoradas = recinto === '' && (desde !== '' || hasta !== '');
  if (fechasIgnoradas) {
    desde = '';
    hasta = '';
  }

  return { recinto, estado, plantilla, desde, hasta, ronda, filas, ajustado, fechasIgnoradas };
}

/**
 * Los parametros que se le mandan a `GET /notif/envios`.
 *
 * Lo vacio se omite a proposito: `siteId=` con cadena vacia hace que el DTO
 * responda 400 porque lo valida como UUID.
 */
export function parametrosDeConsulta(filtro: FiltroEnvios): URLSearchParams {
  const busqueda = new URLSearchParams();
  if (filtro.recinto) busqueda.set('siteId', filtro.recinto);
  if (filtro.estado) busqueda.set('estado', filtro.estado);
  if (filtro.plantilla) busqueda.set('plantilla', filtro.plantilla);
  if (filtro.desde) busqueda.set('desde', filtro.desde);
  if (filtro.hasta) busqueda.set('hasta', filtro.hasta);
  busqueda.set('limite', String(filtro.filas));
  return busqueda;
}

/**
 * Los parametros de la URL de la pantalla, para armar enlaces sin perderle el
 * filtro a los otros bloques de la pagina.
 */
export function parametrosDeUrl(
  filtro: Partial<FiltroEnvios>,
  otros?: URLSearchParams,
): URLSearchParams {
  const busqueda = new URLSearchParams(otros ? otros.toString() : undefined);
  for (const clave of CLAVES_URL_ENVIOS) busqueda.delete(clave);
  // Con ronda no viaja nada mas: el endpoint de la ronda no admite filtros ni
  // limite, y arrastrarlos dejaria en la barra un filtro que no se esta
  // aplicando.
  if (filtro.ronda) {
    busqueda.set(CLAVE_URL.ronda, filtro.ronda);
    return busqueda;
  }
  if (filtro.recinto) busqueda.set(CLAVE_URL.recinto, filtro.recinto);
  if (filtro.estado) busqueda.set(CLAVE_URL.estado, filtro.estado);
  if (filtro.plantilla) busqueda.set(CLAVE_URL.plantilla, filtro.plantilla);
  if (filtro.desde) busqueda.set(CLAVE_URL.desde, filtro.desde);
  if (filtro.hasta) busqueda.set(CLAVE_URL.hasta, filtro.hasta);
  if (filtro.filas && filtro.filas !== FILAS_POR_DEFECTO) {
    busqueda.set(CLAVE_URL.filas, String(filtro.filas));
  }
  return busqueda;
}

/**
 * El siguiente tamaño de pagina, o `null` si ya se esta pidiendo el maximo.
 *
 * `GET /notif/envios` no tiene cursor ni desplazamiento: solo `limite`. Ver mas
 * significa pedir mas filas de la misma consulta, no una pagina siguiente, y la
 * pantalla lo dice con esas palabras para que nadie crea que esta paginando.
 */
export function siguienteTamano(filas: number): number | null {
  for (const disponible of FILAS_DISPONIBLES) {
    if (disponible > filas) return disponible;
  }
  return null;
}

/**
 * `true` si la consulta trajo tantas filas como se pidieron: puede haber mas
 * envios que no se estan viendo.
 */
export function puedeHaberMas(envios: readonly EnvioRegistrado[], filtro: FiltroEnvios): boolean {
  return envios.length >= filtro.filas;
}

/** La zona horaria del recinto elegido, o `null` si no hay ninguno elegido. */
export function zonaDelRecinto(
  recintos: readonly RecintoConocido[],
  recintoId: string,
): string | null {
  if (!recintoId) return null;
  return recintos.find((recinto) => recinto.id === recintoId)?.timezone ?? null;
}

/**
 * Como se nombra una ronda en el selector.
 *
 * Sin nombre de guardia ni de persona: en el selector de un panel solo hace
 * falta saber de que recinto y de que hora se habla.
 */
export function etiquetaDeRonda(ronda: RondaConocida): string {
  const cuando = ronda.scheduledStartAt.slice(0, 10);
  return `${ronda.siteName} · ${ronda.routeName} · ${cuando}`;
}

/** Los 8 primeros caracteres de un id: alcanza para cruzarlo, corto de leer. */
export function referenciaCorta(id: string | null): string {
  if (!id) return '—';
  return id.length > 8 ? id.slice(0, 8) : id;
}
