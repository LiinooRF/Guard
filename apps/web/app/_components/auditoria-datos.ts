/**
 * Auditoria de acciones del tenant (#104) — tipos y calculo puro.
 *
 * Igual que `stats-charts-data.ts`: aca no hay React ni fetch, a proposito. Es
 * lo unico de este archivo que se puede probar con Jest sin navegador ni base,
 * y es donde vive lo que de verdad se puede equivocar: el corte de los dias en
 * la zona horaria del recinto, el cursor de paginado y la lectura de cada
 * codigo de accion.
 *
 * La forma de las filas es la que arma `apps/api/src/audit/audit.service.ts`
 * (`AuditService.list`), verificada contra la migracion
 * `1724598000000-CreateAuditLog.ts`. Las columnas que existen son exactamente
 * estas: id, tenant_id, actor_id, actor_label, action, entity_type, entity_id,
 * summary, request_id, created_at. `request_id` NO se expone en la respuesta y
 * por eso no aparece aca.
 *
 * La aritmetica de calendario sin zona (`esDia`, `sumarDias`, `diasEntre`) se
 * reusa de `stats-charts-data.ts` en vez de reescribirla: es la misma cuenta y
 * dos copias se desincronizan. Lo que si vive aca es todo lo que necesita la
 * zona horaria del recinto, que ese modulo no tiene.
 */

import { diasEntre, esDia, sumarDias } from './stats-charts-data';

/* ------------------------------------------------------------------ */
/* Respuesta de la API                                                 */
/* ------------------------------------------------------------------ */

/**
 * Una fila de `GET /admin/audit`.
 *
 * `actorId` puede venir nulo y `actorLabel` nunca: la columna `actor_id` no
 * lleva clave foranea justamente para que la fila siga diciendo quien fue
 * cuando ese usuario ya se elimino. Por eso la interfaz muestra SIEMPRE
 * `actorLabel` y usa `actorId` solo para filtrar.
 */
export interface RegistroAuditoria {
  readonly id: string;
  readonly actorId: string | null;
  readonly actorLabel: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly summary: string | null;
  /** Instante ISO. `created_at` es `timestamptz`, asi que trae zona. */
  readonly createdAt: string;
}

/** Un usuario del tenant, tal como lo devuelve `GET /admin/users`. */
export interface UsuarioAuditable {
  readonly id: string;
  readonly givenName: string;
  readonly familyName: string;
}

/* ------------------------------------------------------------------ */
/* Catalogo de acciones                                                */
/* ------------------------------------------------------------------ */

export const GRUPOS_ACCION = ['personas', 'recintos', 'rutas', 'reglas', 'operacion'] as const;
export type GrupoAccion = (typeof GRUPOS_ACCION)[number];

export const ETIQUETA_GRUPO: Record<GrupoAccion, string> = {
  personas: 'Personas y accesos',
  recintos: 'Recintos, puntos y etiquetas',
  rutas: 'Rutas y turnos',
  reglas: 'Reglas y políticas',
  operacion: 'Operación',
};

/**
 * Si el servidor escribe hoy esta accion.
 *
 * Existe porque la lista de acciones declarada (`AUDIT_ACTIONS` en
 * `apps/api/src/audit/audit.service.ts`) es mas larga que la lista de acciones
 * que algun servicio realmente registra. Sin esto, filtrar por "alta de
 * usuario" devuelve cero filas y se lee como "nadie creo usuarios", que es lo
 * contrario de lo que pasa: se crearon y no quedaron anotados.
 *
 * Vacio y no-registrado NO son lo mismo, y esta es la diferencia entre una
 * auditoria y una falsa sensacion de control.
 */
export type EstadoRegistro = 'completo' | 'parcial' | 'ausente';

export interface FichaAccion {
  readonly codigo: string;
  /** Como se lee en pantalla, en lenguaje del jefe de operaciones. */
  readonly etiqueta: string;
  /** Que significa que aparezca esta linea. */
  readonly descripcion: string;
  readonly grupo: GrupoAccion;
  readonly registro: EstadoRegistro;
  /** Solo cuando `registro` no es 'completo': que parte falta y por que. */
  readonly nota?: string;
}

/**
 * Fichas de las acciones que el producto declara.
 *
 * El estado de `registro` se obtuvo buscando cada codigo en `apps/api/src`
 * (quien llama a `AuditService.record`) el 2026-08-03, sobre `staging`. Es una
 * FOTO, y una foto se vence.
 *
 * ATENCION, y esto es obligatorio, no una sugerencia: **cada `audit.record`
 * nuevo que se agregue en el backend obliga a poner `registro: 'completo'` (y a
 * borrar la `nota`) de esa ficha en el MISMO PR.** Si no, este panel va a
 * seguir afirmando "el sistema todavía no anota el alta de usuarios" sobre
 * datos que ya existen: el mismo falso negativo que este archivo dice combatir,
 * pero al reves y con la confianza cambiada de lado. Ese dato alimenta tres
 * lugares: el aviso rojo de la cabecera, el sufijo "— sin registro" del
 * selector y el texto que sale cuando el listado viene vacio.
 *
 * Lo correcto a futuro es DERIVARLO en vez de escribirlo a mano: si el codigo
 * aparece en `GET /admin/audit/actions`, alguien lo esta escribiendo y no
 * corresponde marcarlo como ausente. Eso pide mover el catalogo a
 * `packages/shared` (revision de dos personas), y esta anotado en
 * INTEGRACION.md seccion 5 como paso del integrador.
 */
export const CATALOGO_ACCIONES: readonly FichaAccion[] = [
  {
    codigo: 'usuario.creado',
    etiqueta: 'Alta de usuario',
    descripcion: 'Se creó una cuenta de la empresa (guardia, supervisor o administrador).',
    grupo: 'personas',
    registro: 'ausente',
    nota: 'El sistema todavía no anota el alta de usuarios: crear una cuenta funciona, pero no deja registro aquí.',
  },
  {
    codigo: 'usuario.desactivado',
    etiqueta: 'Baja de usuario',
    descripcion: 'Se desactivó una cuenta y dejó de poder entrar.',
    grupo: 'personas',
    registro: 'ausente',
    nota: 'El sistema todavía no anota la baja de usuarios.',
  },
  {
    codigo: 'usuario.sesiones_revocadas',
    etiqueta: 'Cierre de sesiones de un usuario',
    descripcion: 'Un administrador cerró todas las sesiones abiertas de esa persona.',
    grupo: 'personas',
    registro: 'ausente',
    nota: 'El sistema todavía no anota el cierre forzado de sesiones.',
  },
  {
    codigo: 'recinto.creado',
    etiqueta: 'Alta de recinto',
    descripcion: 'Se agregó un recinto o sucursal a la empresa.',
    grupo: 'recintos',
    registro: 'ausente',
    nota: 'El sistema todavía no anota el alta de recintos.',
  },
  {
    codigo: 'recinto.desactivado',
    etiqueta: 'Baja de recinto',
    descripcion: 'Se desactivó un recinto y dejó de aceptar rondas.',
    grupo: 'recintos',
    registro: 'ausente',
    nota: 'El sistema todavía no anota la baja de recintos.',
  },
  // Las cuatro fichas de terreno pasaron a 'completo' en #309: AdminService
  // ahora llama a AuditService.record en los dos caminos —el del ADMIN y el del
  // SUPERVISOR—, asi que el registro ya no depende de por que puerta se entro.
  {
    codigo: 'punto.creado',
    etiqueta: 'Alta de punto de control',
    descripcion: 'Se agregó un punto de control a un recinto, o se importó una tanda por CSV.',
    grupo: 'recintos',
    registro: 'completo',
  },
  {
    codigo: 'punto.modificado',
    etiqueta: 'Cambio en un punto de control',
    descripcion:
      'Cambió el nombre, la criticidad, la exigencia de foto, la ubicación o la vigencia de un punto. ' +
      'El detalle dice cuáles cambiaron: mover las coordenadas y dar de baja un punto quedan escritos aparte.',
    grupo: 'recintos',
    registro: 'completo',
  },
  {
    codigo: 'etiqueta.registrada',
    etiqueta: 'Etiqueta emitida o registrada',
    descripcion:
      'Se asoció una etiqueta NFC —o un QR de respaldo— a un punto de control. ' +
      'Cuando reemplaza a otra, el detalle nombra la que quedó fuera de servicio.',
    grupo: 'recintos',
    registro: 'completo',
  },
  {
    codigo: 'etiqueta.retirada',
    etiqueta: 'Etiqueta retirada',
    descripcion: 'Se dio de baja una etiqueta: deja de servir para marcar el punto.',
    grupo: 'recintos',
    registro: 'completo',
  },
  {
    codigo: 'ruta.creada',
    etiqueta: 'Alta de ruta',
    descripcion: 'Se creó una ruta: la secuencia de puntos que recorre el guardia.',
    grupo: 'rutas',
    registro: 'ausente',
    nota: 'El sistema todavía no anota el alta de rutas.',
  },
  {
    codigo: 'ruta.modificada',
    etiqueta: 'Cambio en una ruta',
    descripcion: 'Cambió la secuencia de puntos, la duración estimada o la tolerancia de una ruta.',
    grupo: 'rutas',
    registro: 'ausente',
    nota: 'El sistema todavía no anota los cambios de ruta.',
  },
  {
    codigo: 'rondas.generadas',
    etiqueta: 'Rondas generadas desde la programación',
    descripcion: 'La programación de turnos creó las rondas de un día de servicio.',
    grupo: 'operacion',
    registro: 'completo',
  },
  {
    codigo: 'reglas.modificadas',
    etiqueta: 'Cambio de reglas',
    descripcion:
      'Cambió la configuración de la empresa, de un recinto o de un punto: umbral de cumplimiento, exigencia de foto, retención y demás.',
    grupo: 'reglas',
    registro: 'completo',
  },
  {
    codigo: 'escalamiento.modificado',
    etiqueta: 'Cambio en la cadena de avisos',
    descripcion: 'Cambió a quién y en qué orden se avisa cuando hay una novedad crítica o un pánico.',
    grupo: 'reglas',
    registro: 'ausente',
    nota: 'El sistema todavía no anota los cambios de la cadena de avisos.',
  },
  {
    codigo: 'politica_seguridad.modificada',
    etiqueta: 'Cambio en la política de ingreso',
    descripcion: 'Cambiaron los intentos de contraseña permitidos o el tiempo de bloqueo.',
    grupo: 'reglas',
    registro: 'ausente',
    nota: 'El sistema todavía no anota los cambios de la política de ingreso.',
  },
  {
    codigo: 'consentimiento.aviso_publicado',
    etiqueta: 'Aviso de geolocalización publicado',
    descripcion:
      'Se publicó una versión nueva del aviso de rastreo de ubicación que cada trabajador debe aceptar.',
    grupo: 'reglas',
    registro: 'completo',
  },
];

const POR_CODIGO = new Map<string, FichaAccion>(
  CATALOGO_ACCIONES.map((ficha) => [ficha.codigo, ficha]),
);

/** Primera letra en mayuscula, sin tocar el resto. */
function capitalizar(texto: string): string {
  return texto.length ? `${texto[0]?.toUpperCase() ?? ''}${texto.slice(1)}` : texto;
}

/**
 * Ficha de una accion, inventando una legible cuando no esta en el catalogo.
 *
 * Una accion desconocida NO se esconde: si el backend empezo a registrar algo
 * nuevo, el admin tiene que verlo aunque este panel no sepa como se llama. Un
 * registro de auditoria que filtra lo que no reconoce no sirve como registro.
 */
export function describirAccion(codigo: string): FichaAccion {
  const conocida = POR_CODIGO.get(codigo);
  if (conocida) return conocida;

  const partes = codigo.split('.').filter((parte) => parte.length > 0);
  const entidad = capitalizar((partes[0] ?? codigo).replace(/_/g, ' '));
  const verbo = (partes.slice(1).join(' ') || '').replace(/_/g, ' ');
  return {
    codigo,
    etiqueta: verbo ? `${entidad} · ${verbo}` : entidad,
    descripcion: 'Acción que este panel todavía no sabe describir. El registro es válido igual.',
    grupo: 'operacion',
    // Si llego en los datos, alguien la esta escribiendo. No hay motivo para
    // advertir de un hueco que no consta.
    registro: 'completo',
  };
}

/**
 * Opciones del selector de accion: el catalogo del producto MAS lo que ya
 * aparece en los datos del tenant.
 *
 * Las dos fuentes hacen falta. Solo el catalogo esconderia una accion nueva del
 * backend; solo los datos esconderia justamente las que no se estan
 * registrando, que son las que hay que poder buscar para descubrir el hueco.
 */
export function opcionesDeAccion(presentes: readonly string[]): FichaAccion[] {
  const vistos = new Set<string>();
  const opciones: FichaAccion[] = [];
  for (const ficha of CATALOGO_ACCIONES) {
    vistos.add(ficha.codigo);
    opciones.push(ficha);
  }
  for (const codigo of presentes) {
    if (vistos.has(codigo)) continue;
    vistos.add(codigo);
    opciones.push(describirAccion(codigo));
  }
  return opciones;
}

/** Fichas agrupadas para pintar `<optgroup>`, en el orden de GRUPOS_ACCION. */
export function agruparAcciones(
  fichas: readonly FichaAccion[],
): Array<{ grupo: GrupoAccion; etiqueta: string; acciones: FichaAccion[] }> {
  return GRUPOS_ACCION.map((grupo) => ({
    grupo,
    etiqueta: ETIQUETA_GRUPO[grupo],
    acciones: fichas.filter((ficha) => ficha.grupo === grupo),
  })).filter((seccion) => seccion.acciones.length > 0);
}

/** Las acciones declaradas que hoy no dejan rastro, para el aviso de cabecera. */
export function accionesSinRegistro(): FichaAccion[] {
  return CATALOGO_ACCIONES.filter((ficha) => ficha.registro !== 'completo');
}

/* ------------------------------------------------------------------ */
/* Calendario en la zona horaria del recinto                           */
/* ------------------------------------------------------------------ */

/**
 * Zona de respaldo. NO es una regla de negocio inventada: es el mismo default
 * que declara la columna `sites.timezone` en la migracion
 * `1722524400000-CreateDemoDomain.ts`. Solo se usa mientras la API no entregue
 * la zona del tenant (ver INTEGRACION.md).
 */
export const ZONA_POR_DEFECTO = 'America/Santiago';

const FORMATEADORES = new Map<string, Intl.DateTimeFormat>();

function formateador(zona: string): Intl.DateTimeFormat {
  const guardado = FORMATEADORES.get(zona);
  if (guardado) return guardado;
  const creado = new Intl.DateTimeFormat('en-US', {
    timeZone: zona,
    // h23 y no hour12:false: con hour12 algunas versiones de ICU devuelven "24"
    // a medianoche, y "24" corrido a Date.UTC suma un dia entero sin avisar.
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  FORMATEADORES.set(zona, creado);
  return creado;
}

/**
 * `true` si `Intl` reconoce la zona. La zona sale de la base (`sites.timezone`)
 * y un valor invalido hace que `Intl.DateTimeFormat` lance: una zona mal
 * cargada no puede tumbar el panel completo.
 */
export function zonaValida(zona: string): boolean {
  try {
    formateador(zona).format(new Date(0));
    return true;
  } catch {
    FORMATEADORES.delete(zona);
    return false;
  }
}

/** La zona pedida si sirve, y la de respaldo si no. */
export function resolverZona(zona: string | undefined | null): string {
  if (typeof zona === 'string' && zona.length > 0 && zonaValida(zona)) return zona;
  return ZONA_POR_DEFECTO;
}

export interface ParedEnZona {
  readonly anio: number;
  readonly mes: number;
  readonly dia: number;
  readonly hora: number;
  readonly minuto: number;
  readonly segundo: number;
}

function numeroDe(mapa: Map<string, string>, clave: string): number {
  const valor = mapa.get(clave);
  return valor === undefined ? Number.NaN : Number(valor);
}

/** El reloj de pared que marca `instante` en `zona`. */
export function paredEnZona(instante: Date, zona: string): ParedEnZona {
  const mapa = new Map<string, string>();
  for (const parte of formateador(zona).formatToParts(instante)) {
    mapa.set(parte.type, parte.value);
  }
  return {
    anio: numeroDe(mapa, 'year'),
    mes: numeroDe(mapa, 'month'),
    dia: numeroDe(mapa, 'day'),
    hora: numeroDe(mapa, 'hour'),
    minuto: numeroDe(mapa, 'minute'),
    segundo: numeroDe(mapa, 'second'),
  };
}

function dosDigitos(valor: number): string {
  return valor < 10 ? `0${valor}` : String(valor);
}

/** El dia calendario (YYYY-MM-DD) en el que cae `instante` segun `zona`. */
export function diaEnZona(instante: Date, zona: string): string {
  const pared = paredEnZona(instante, zona);
  return `${pared.anio}-${dosDigitos(pared.mes)}-${dosDigitos(pared.dia)}`;
}

/** Hoy, en la zona del recinto. Se calcula en el servidor y viaja como prop. */
export function hoyEnZona(zona: string, ahora: number = Date.now()): string {
  return diaEnZona(new Date(ahora), zona);
}

/** Desfase de la zona respecto de UTC, en milisegundos, en ese instante. */
function desfaseMs(instante: Date, zona: string): number {
  const pared = paredEnZona(instante, zona);
  const comoUtc = Date.UTC(
    pared.anio,
    pared.mes - 1,
    pared.dia,
    pared.hora,
    pared.minuto,
    pared.segundo,
  );
  // formatToParts llega al segundo: se comparan segundos con segundos.
  return comoUtc - Math.floor(instante.getTime() / 1000) * 1000;
}

/**
 * Instante real de un reloj de pared (`YYYY-MM-DDTHH:mm:ss`) en `zona`.
 *
 * Se tantea dos veces porque el primer intento usa el desfase que rige en un
 * instante que todavia no es el correcto, y ese instante puede caer del otro
 * lado de un cambio de hora.
 *
 * El tercer caso es el que se olvida: hay relojes de pared que NO EXISTEN. En
 * Santiago, el 6 de septiembre de 2026 el reloj salta de las 00:00 a las 01:00,
 * asi que "6 de septiembre a las 00:00" no ocurrio nunca. Ahi no hay respuesta
 * exacta y se toma el instante POSTERIOR, que es el primero que si existe: un
 * dia tiene que empezar en alguna parte aunque su medianoche se la haya comido
 * el cambio de hora. Elegir el anterior mandaria el borde al dia de antes y
 * haria que el panel mostrara un dia con 25 horas.
 */
export function instanteDeParedEnZona(pared: string, zona: string): Date {
  const supuesto = Date.parse(`${pared}Z`);
  if (Number.isNaN(supuesto)) return new Date(Number.NaN);

  const desfasePrimero = desfaseMs(new Date(supuesto), zona);
  const primero = supuesto - desfasePrimero;
  const desfaseSegundo = desfaseMs(new Date(primero), zona);
  if (desfaseSegundo === desfasePrimero) return new Date(primero);

  const segundo = supuesto - desfaseSegundo;
  // Si el segundo tanteo se sostiene, ese es el instante bueno.
  if (desfaseMs(new Date(segundo), zona) === desfaseSegundo) return new Date(segundo);
  return new Date(Math.max(primero, segundo));
}

/**
 * Aritmetica de calendario SIN zona, reusada de `stats-charts-data.ts`.
 *
 * Se re-exporta para que quien trabaje en este panel no tenga que saber que la
 * cuenta vive en el modulo de informes, y para que la suma del dia se haga
 * siempre sobre el reloj de pared antes de convertir a instante.
 */
export const sumarDiasCalendario = sumarDias;
export const esDiaCalendario = esDia;
export const diasEntreCalendario = diasEntre;

/** El instante en que empieza `dia` en `zona`. */
export function inicioDelDia(dia: string, zona: string): Date {
  return instanteDeParedEnZona(`${dia}T00:00:00`, zona);
}

/**
 * El instante en que EMPIEZA el dia siguiente, en `zona`. Fin exclusivo.
 *
 * El dia se suma al reloj de pared ANTES de convertir, nunca despues: sumar
 * 24 horas al instante da mal en cada cambio de hora. En Santiago, el
 * 2026-09-05 dura 23 horas y el 2026-04-04 dura 25. Con la suma sobre el
 * instante, el primero se lleva una hora del dia siguiente y el segundo pierde
 * la ultima hora del propio dia — que es justo la hora en la que se cambian las
 * cosas antes de irse.
 */
export function finExclusivoDelDia(dia: string, zona: string): Date {
  return instanteDeParedEnZona(`${sumarDiasCalendario(dia, 1)}T00:00:00`, zona);
}

/**
 * El ultimo instante que todavia pertenece a `dia`, en `zona`.
 *
 * `GET /admin/audit` compara con `created_at <= $to`, o sea inclusivo: hay que
 * mandarle un borde inclusivo. Se resta 1 ms al fin exclusivo. `timestamptz`
 * guarda microsegundos, asi que un registro escrito en el ultimo milisegundo
 * del dia quedaria fuera; a cambio, ninguno del dia siguiente se cuela. Se
 * prefiere ese error, que es de un microsegundo, antes que atribuir una accion
 * al dia equivocado.
 */
export function finInclusivoDelDia(dia: string, zona: string): Date {
  return new Date(finExclusivoDelDia(dia, zona).getTime() - 1);
}

/** "03-08-2026 14:35" en la zona del recinto, sin depender del locale. */
export function formatearInstante(iso: string, zona: string): string {
  const instante = new Date(iso);
  if (Number.isNaN(instante.getTime())) return 'Sin fecha';
  const pared = paredEnZona(instante, zona);
  return `${dosDigitos(pared.dia)}-${dosDigitos(pared.mes)}-${pared.anio} ${dosDigitos(
    pared.hora,
  )}:${dosDigitos(pared.minuto)}`;
}

/** Igual que el anterior pero con segundos: dos cambios seguidos se distinguen. */
export function formatearInstanteExacto(iso: string, zona: string): string {
  const instante = new Date(iso);
  if (Number.isNaN(instante.getTime())) return 'Sin fecha';
  const pared = paredEnZona(instante, zona);
  return `${formatearInstante(iso, zona)}:${dosDigitos(pared.segundo)}`;
}

/* ------------------------------------------------------------------ */
/* Parametros configurables                                            */
/* ------------------------------------------------------------------ */

/**
 * Los tres numeros del panel. Salen de `GET /rules/effective`, NO de aca.
 *
 * Los valores de abajo son el ultimo recurso mientras la API no responda esas
 * reglas —hoy todavia no existen en `rules.ts`; el zod y la ficha exactos estan
 * escritos en INTEGRACION.md para que los aplique el integrador—. Coinciden con
 * el default propuesto; si ese default cambia, manda el del servidor.
 */
export interface ReglasAuditoria {
  /** Dias que abre el panel cuando nadie eligio periodo. */
  readonly diasPorDefecto: number;
  /** Periodo mas largo que el panel consulta de una vez. */
  readonly diasMaximos: number;
  /** Filas por pagina. La API topa en 500. */
  readonly filasPorPagina: number;
}

const SIN_REGLA: ReglasAuditoria = {
  diasPorDefecto: 30,
  diasMaximos: 366,
  filasPorPagina: 100,
};

/** Tope duro de `GET /admin/audit` (`@Max(500)` en `AuditQuery`). */
export const TOPE_FILAS_API = 500;

/**
 * Cuantas filas se piden de verdad en una consulta.
 *
 * Es lo unico que se puede decir en pantalla: `TOPE_FILAS_API` es el techo de
 * la API, no lo que el panel pide. Con el default (100) prometer 500 seria un
 * dato falso, y en un registro de auditoria ese es justo el error que no se
 * puede cometer. Vive aca —y no repetida en cada sitio— porque el paginado y el
 * texto del pie tienen que dar el mismo numero siempre.
 */
export function filasPorConsulta(reglas: ReglasAuditoria): number {
  return Math.min(reglas.filasPorPagina, TOPE_FILAS_API);
}

function entero(valor: unknown, minimo: number, maximo: number): number | undefined {
  if (typeof valor !== 'number' || !Number.isInteger(valor)) return undefined;
  if (valor < minimo || valor > maximo) return undefined;
  return valor;
}

/**
 * Lee las reglas del panel de lo que devolvio `GET /rules/effective`.
 *
 * Tolera que las claves no existan todavia: mientras el integrador no aplique
 * las reglas nuevas, el panel abre igual con el ultimo recurso.
 */
export function resolverReglasAuditoria(
  efectivas: Record<string, unknown> | undefined | null,
): ReglasAuditoria {
  const fuente = efectivas ?? {};
  return {
    diasPorDefecto: entero(fuente['auditDefaultRangeDays'], 1, 366) ?? SIN_REGLA.diasPorDefecto,
    diasMaximos: entero(fuente['auditMaxRangeDays'], 7, 3650) ?? SIN_REGLA.diasMaximos,
    filasPorPagina:
      entero(fuente['auditPageSize'], 20, TOPE_FILAS_API) ?? SIN_REGLA.filasPorPagina,
  };
}

/* ------------------------------------------------------------------ */
/* Filtro                                                              */
/* ------------------------------------------------------------------ */

export interface FiltroAuditoria {
  readonly desde: string;
  readonly hasta: string;
  /** UUID del actor, o cadena vacia para "cualquiera". */
  readonly actorId: string;
  /** Codigo de accion, o cadena vacia para "todas". */
  readonly accion: string;
  /**
   * Cursor del paginado: instante ISO hasta el que se pide esta pagina. Vacio
   * en la primera. Nunca lleva nombres: en la URL solo viajan ids y fechas.
   */
  readonly corte: string;
  /** `true` si lo que traia la URL no servia y hubo que corregirlo. */
  readonly ajustado: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function esUuid(valor: string | undefined | null): valor is string {
  return typeof valor === 'string' && UUID.test(valor);
}

/** `true` si el texto es un instante ISO que `Date` sabe leer. */
export function esInstante(valor: string | undefined | null): valor is string {
  return typeof valor === 'string' && valor.length > 0 && !Number.isNaN(Date.parse(valor));
}

export interface ParametrosUrlAuditoria {
  readonly desde?: string | undefined;
  readonly hasta?: string | undefined;
  readonly usuario?: string | undefined;
  readonly accion?: string | undefined;
  readonly antes?: string | undefined;
}

/**
 * Las claves de este panel en la URL, TODAS con prefijo `aud_`.
 *
 * El prefijo no es cosmetico. En `app/app/[role]/page.tsx` conviven varios
 * bloques que leen los mismos `searchParams`, y el de informes (#87, ya en
 * staging) usa `desde`, `hasta`, `recinto`, `sucursal` y `agrupacion`
 * (`stats-charts.tsx`, `stats-charts-filters.tsx`). Sin prefijo, aplicar un
 * periodo aca le cambiaria el periodo a los informes y viceversa; y como el
 * tope de los informes es de 731 dias y el de este panel de 366, elegir
 * "ultimos 2 años" alla haria aparecer aca el aviso de "el filtro que traia el
 * enlace no servia". Dos bloques distintos en una misma pagina no pueden
 * compartir el espacio de nombres de la query.
 */
export const CLAVE_URL = {
  desde: 'aud_desde',
  hasta: 'aud_hasta',
  usuario: 'aud_usuario',
  accion: 'aud_accion',
  antes: 'aud_antes',
} as const;

/** Todas las claves que este panel se considera dueño de escribir y de borrar. */
export const CLAVES_URL_AUDITORIA: readonly string[] = Object.values(CLAVE_URL);

/** Los `searchParams` de la pagina, tal como los entrega Next. */
export type ParametrosDePagina = Record<string, string | string[] | undefined>;

function primerValor(valor: string | string[] | undefined): string | undefined {
  return Array.isArray(valor) ? valor[0] : valor;
}

/** Lo que este panel lee de la URL de la pagina, ya sin el prefijo. */
export function parametrosDeAuditoria(parametros: ParametrosDePagina): ParametrosUrlAuditoria {
  return {
    desde: primerValor(parametros[CLAVE_URL.desde]),
    hasta: primerValor(parametros[CLAVE_URL.hasta]),
    usuario: primerValor(parametros[CLAVE_URL.usuario]),
    accion: primerValor(parametros[CLAVE_URL.accion]),
    antes: primerValor(parametros[CLAVE_URL.antes]),
  };
}

/**
 * Todo lo demas que ya viaja en la URL de la pagina.
 *
 * Se conserva tal cual —incluidas las claves repetidas— para que un enlace de
 * este panel no le borre el filtro a otro bloque. Este panel solo manda sobre
 * sus propias claves.
 */
export function otrosParametrosDeLaPagina(parametros: ParametrosDePagina): URLSearchParams {
  const busqueda = new URLSearchParams();
  for (const [clave, valor] of Object.entries(parametros)) {
    if (CLAVES_URL_AUDITORIA.includes(clave)) continue;
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
 * Nunca lanza: un enlace viejo, o una URL editada a mano, tiene que abrir el
 * panel igual —con el periodo por defecto y un aviso— y no con una pantalla de
 * error. La validacion dura la sigue haciendo el servidor; esto es para que el
 * jefe de operaciones no la vea nunca.
 */
export function resolverFiltro(
  parametros: ParametrosUrlAuditoria,
  hoy: string,
  reglas: ReglasAuditoria,
  zona: string,
): FiltroAuditoria {
  let ajustado = false;

  let hasta = hoy;
  if (esDiaCalendario(parametros.hasta)) {
    hasta = parametros.hasta > hoy ? hoy : parametros.hasta;
  } else if (parametros.hasta !== undefined) {
    ajustado = true;
  }

  let desde = sumarDiasCalendario(hasta, -(reglas.diasPorDefecto - 1));
  if (esDiaCalendario(parametros.desde)) {
    if (parametros.desde > hasta) ajustado = true;
    else desde = parametros.desde;
  } else if (parametros.desde !== undefined) {
    ajustado = true;
  }

  if (diasEntreCalendario(desde, hasta) > reglas.diasMaximos) {
    desde = sumarDiasCalendario(hasta, -(reglas.diasMaximos - 1));
    ajustado = true;
  }

  let actorId = '';
  if (esUuid(parametros.usuario)) actorId = parametros.usuario;
  else if (parametros.usuario) ajustado = true;

  const accion = typeof parametros.accion === 'string' ? parametros.accion.trim() : '';

  // El cursor solo vale dentro del periodo: si no, la pagina siguiente
  // mostraria cosas fuera de lo que dice el encabezado.
  let corte = '';
  if (esInstante(parametros.antes)) {
    const instante = new Date(parametros.antes);
    const limiteAlto = finInclusivoDelDia(hasta, zona);
    const limiteBajo = inicioDelDia(desde, zona);
    if (instante <= limiteAlto && instante >= limiteBajo) corte = instante.toISOString();
    else ajustado = true;
  } else if (parametros.antes !== undefined) {
    ajustado = true;
  }

  return { desde, hasta, actorId, accion, corte, ajustado };
}

/**
 * Los parametros que se le mandan a `GET /admin/audit`.
 *
 * Se omite lo vacio a proposito: `actorId=` con cadena vacia hace que la API
 * responda 400, porque el DTO lo valida como UUID.
 */
export function parametrosDeConsulta(
  filtro: FiltroAuditoria,
  reglas: ReglasAuditoria,
  zona: string,
): URLSearchParams {
  const busqueda = new URLSearchParams();
  busqueda.set('from', inicioDelDia(filtro.desde, zona).toISOString());
  busqueda.set(
    'to',
    filtro.corte ? filtro.corte : finInclusivoDelDia(filtro.hasta, zona).toISOString(),
  );
  if (filtro.actorId) busqueda.set('actorId', filtro.actorId);
  if (filtro.accion) busqueda.set('action', filtro.accion);
  busqueda.set('limit', String(filasPorConsulta(reglas)));
  return busqueda;
}

/**
 * Los parametros de la URL del panel, para armar enlaces sin perder el filtro.
 *
 * `otros` son los parametros que ya venian en la URL de la pagina y que NO son
 * de este panel (los de los informes, por ejemplo). Se copian tal cual: un
 * enlace de "ver anteriores" no puede dejar sin recinto al bloque de al lado.
 * Lo unico que se reescribe son las claves `aud_*`.
 */
export function parametrosDeUrl(
  filtro: FiltroAuditoria,
  corte?: string,
  otros?: URLSearchParams,
): URLSearchParams {
  const busqueda = new URLSearchParams(otros ? otros.toString() : undefined);
  for (const clave of CLAVES_URL_AUDITORIA) busqueda.delete(clave);
  busqueda.set(CLAVE_URL.desde, filtro.desde);
  busqueda.set(CLAVE_URL.hasta, filtro.hasta);
  if (filtro.actorId) busqueda.set(CLAVE_URL.usuario, filtro.actorId);
  if (filtro.accion) busqueda.set(CLAVE_URL.accion, filtro.accion);
  const siguiente = corte ?? filtro.corte;
  if (siguiente) busqueda.set(CLAVE_URL.antes, siguiente);
  return busqueda;
}

/* ------------------------------------------------------------------ */
/* Paginado por cursor                                                 */
/* ------------------------------------------------------------------ */

/**
 * `GET /admin/audit` no tiene cursor ni desplazamiento: solo `from`, `to` y
 * `limit`, y ordena por `created_at DESC`. El paginado se arma moviendo `to`
 * hacia atras con la fecha de la ultima fila mostrada.
 *
 * El borde se deja INCLUSIVO —se repite la ultima fila como primera de la
 * pagina siguiente— y no exclusivo restando un milisegundo. Restar arriesga
 * saltarse las filas escritas en el mismo milisegundo, y en una auditoria
 * perder una linea es peor que repetirla: la linea repetida se ve y se entiende;
 * la que falta, no.
 *
 * Devuelve `null` cuando no hay pagina siguiente que sirva. El caso a cuidar es
 * que TODAS las filas de la pagina compartan el mismo instante: ahi el cursor
 * no avanza y el enlace giraria sobre si mismo para siempre.
 */
export function siguienteCorte(
  registros: readonly RegistroAuditoria[],
  filtro: FiltroAuditoria,
  reglas: ReglasAuditoria,
): string | null {
  const pedidas = filasPorConsulta(reglas);
  if (registros.length < pedidas) return null;

  const ultima = registros[registros.length - 1];
  if (!ultima || !esInstante(ultima.createdAt)) return null;

  const candidato = new Date(ultima.createdAt).toISOString();
  if (filtro.corte && candidato === filtro.corte) return null;
  return candidato;
}

/** `true` si el paginado se atasco: la pagina viene llena y el cursor no avanza. */
export function paginadoAtascado(
  registros: readonly RegistroAuditoria[],
  filtro: FiltroAuditoria,
  reglas: ReglasAuditoria,
): boolean {
  const pedidas = filasPorConsulta(reglas);
  return registros.length >= pedidas && siguienteCorte(registros, filtro, reglas) === null;
}

/* ------------------------------------------------------------------ */
/* Resumen y opciones                                                  */
/* ------------------------------------------------------------------ */

export interface ResumenAuditoria {
  readonly registros: number;
  readonly personas: number;
  readonly acciones: number;
  /** Instante de la fila mas reciente, o null si no hay ninguna. */
  readonly masReciente: string | null;
  readonly masAntigua: string | null;
}

export function resumirAuditoria(registros: readonly RegistroAuditoria[]): ResumenAuditoria {
  const personas = new Set<string>();
  const acciones = new Set<string>();
  for (const registro of registros) {
    // Un actor eliminado no tiene id; se cuenta por su descripcion, que es lo
    // unico que queda de el.
    personas.add(registro.actorId ?? `label:${registro.actorLabel}`);
    acciones.add(registro.action);
  }
  const primera = registros[0];
  const ultima = registros[registros.length - 1];
  return {
    registros: registros.length,
    personas: personas.size,
    acciones: acciones.size,
    // Vienen ordenados de mas nuevo a mas viejo (ORDER BY created_at DESC).
    masReciente: primera ? primera.createdAt : null,
    masAntigua: ultima ? ultima.createdAt : null,
  };
}

export interface OpcionActor {
  readonly id: string;
  readonly nombre: string;
  /** `true` si solo aparece en la auditoria: la cuenta ya no existe. */
  readonly historico: boolean;
}

/**
 * Actores para el selector: los usuarios vigentes de la empresa MAS los que
 * solo quedan en la auditoria.
 *
 * Los segundos importan: una cuenta eliminada sigue teniendo acciones anotadas,
 * y no poder filtrar por ella dejaria justo el caso que se va a querer
 * reconstruir. Si `GET /admin/users` no esta disponible, la lista se arma sola
 * con lo que traen las filas.
 */
export function opcionesDeActor(
  registros: readonly RegistroAuditoria[],
  usuarios: readonly UsuarioAuditable[] = [],
): OpcionActor[] {
  const porId = new Map<string, OpcionActor>();
  for (const usuario of usuarios) {
    const nombre = `${usuario.givenName} ${usuario.familyName}`.trim();
    porId.set(usuario.id, { id: usuario.id, nombre: nombre || 'Sin nombre', historico: false });
  }
  for (const registro of registros) {
    if (!registro.actorId || porId.has(registro.actorId)) continue;
    porId.set(registro.actorId, {
      id: registro.actorId,
      nombre: registro.actorLabel,
      historico: true,
    });
  }
  return [...porId.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

/* ------------------------------------------------------------------ */
/* Entidades                                                           */
/* ------------------------------------------------------------------ */

/**
 * `entity_type` es texto libre y lo escribe cada servicio. Los valores que hoy
 * emite el backend son: `tag`, `schedule_run`, `consent_policy` y
 * `<scope>_rules` (platform_rules, tenant_rules, site_rules, checkpoint_rules).
 * Lo que no este mapeado se muestra tal cual, nunca en blanco.
 */
const ETIQUETA_ENTIDAD: Record<string, string> = {
  tag: 'Etiqueta',
  schedule_run: 'Programación de turnos',
  consent_policy: 'Aviso de geolocalización',
  platform_rules: 'Reglas de la plataforma',
  tenant_rules: 'Reglas de la empresa',
  site_rules: 'Reglas de un recinto',
  checkpoint_rules: 'Reglas de un punto',
  user: 'Usuario',
  site: 'Recinto',
  checkpoint: 'Punto de control',
  route: 'Ruta',
};

export function etiquetaEntidad(entityType: string): string {
  return ETIQUETA_ENTIDAD[entityType] ?? entityType;
}

/** Los 8 primeros caracteres de un UUID: suficiente para cruzarlo, corto de leer. */
export function referenciaCorta(entityId: string | null): string {
  if (!entityId) return '—';
  return entityId.length > 8 ? entityId.slice(0, 8) : entityId;
}

/* ------------------------------------------------------------------ */
/* Exportacion                                                         */
/* ------------------------------------------------------------------ */

export const COLUMNAS_CSV = [
  'Fecha y hora',
  'Zona horaria',
  'Usuario',
  'Accion',
  'Codigo de accion',
  'Sobre que',
  'Referencia',
  'Detalle',
] as const;

/**
 * Filas planas para el CSV. Se exporta el codigo de accion ADEMAS de la
 * etiqueta: la etiqueta es para leer y el codigo es lo que se puede cruzar con
 * el registro del servidor si esto termina anexado a un sumario.
 */
export function filasCsv(
  registros: readonly RegistroAuditoria[],
  zona: string,
): string[][] {
  return registros.map((registro) => [
    formatearInstanteExacto(registro.createdAt, zona),
    zona,
    registro.actorLabel,
    describirAccion(registro.action).etiqueta,
    registro.action,
    etiquetaEntidad(registro.entityType),
    registro.entityId ?? '',
    registro.summary ?? '',
  ]);
}
