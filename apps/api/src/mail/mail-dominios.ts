/**
 * Dominios a los que el producto NO le escribe (#86).
 *
 * EL PROBLEMA, EN UNA LINEA
 * -------------------------
 * Las cuentas demo del producto usan direcciones `@demo-andina.test`. El TLD
 * `.test` esta RESERVADO por norma (RFC 6761, seccion 6.2) y no resuelve en
 * ningun resolvedor publico: no es que "todavia no exista el dominio", es que
 * jamas va a existir. Cada correo a una de esas direcciones es un rebote DURO,
 * y los rebotes duros son exactamente la metrica con la que un proveedor de
 * correo suspende una cuenta nueva.
 *
 * El sintoma que se ve al dia siguiente no es "no llego un correo": es que
 * dejaron de llegar TODOS, incluidos los de los clientes que pagan.
 *
 * POR QUE VIVE EN `mail/` Y NO EN EL CARRIL DEL INFORME
 * -----------------------------------------------------
 * La primera version de este archivo estaba en `reports/` y solo protegia el
 * informe de ronda. Invitaciones, recuperacion de contrasena, escalamiento y
 * avisos de checklist seguian saliendo — y la invitacion es justamente el
 * correo que se manda al crear un tenant demo. El unico cuello por donde pasan
 * TODOS los correos del producto es `MailQueueService.enqueue`, asi que la
 * proteccion vive al lado de la cola.
 *
 * Sigue siendo una funcion pura sobre strings —sin Nest, sin base y sin leer
 * `process.env`— por dos razones que no cambiaron: un guardarraiel que solo se
 * puede probar levantando media aplicacion no se prueba, y quien quiera usarlo
 * fuera de la cola (el despacho del informe lo hace, para no anotar en
 * `report_deliveries` un envio que no va a salir) no tiene que arrastrar la
 * cola con el.
 *
 * NO ES UNA REGLA DE NEGOCIO Y POR ESO NO VA A rules.ts
 * -----------------------------------------------------
 * Las reglas de `rules.ts` las edita el ADMIN de cada empresa. Esta no: es una
 * proteccion de la reputacion de envio de la PLATAFORMA, compartida por todos
 * los tenants. Si un tenant pudiera apagarla, el tenant que se equivoca hunde
 * la entregabilidad de los otros, que es justo lo que hay que evitar en un
 * SaaS multi-tenant con un solo remitente.
 *
 * Los dominios reservados tampoco son "un numero de negocio" escrito en el
 * codigo: son una lista fijada por norma (RFC 2606 y RFC 6761), no una
 * preferencia de un cliente. Lo que si es configurable —y por eso vive en el
 * entorno, no aca— es la lista EXTRA de dominios propios que no se despachan.
 */

/**
 * Token de inyeccion de la lista ya resuelta.
 *
 * Se resuelve UNA vez al armar el modulo y no en cada envio: leer el entorno en
 * caliente haria que dos correos de la misma noche se comportaran distinto
 * segun cuando arranco el proceso.
 */
export const DOMINIOS_NO_DESPACHABLES = Symbol('DOMINIOS_NO_DESPACHABLES');

/** Lista extra, separada por comas. Ej: "demo-andina.cl,staging.voxia.cl". */
export const ENV_DOMINIOS_BLOQUEADOS = 'MAIL_BLOCKED_DOMAINS';

/**
 * Escotilla de escape para desarrollo con Mailpit, que captura todo y no manda
 * nada a internet. Solo el literal 'true' la abre: cualquier otro valor —vacio,
 * ausente, 'TRUE ', 'si', '1'— deja la proteccion puesta. Falla cerrada, igual
 * que las politicas de RLS.
 *
 * Ojo con lo que decide: NO es el interruptor de encendido de la supresion.
 * Decide si los dominios RESERVADOS POR NORMA entran o no a la lista. Con la
 * escotilla abierta, `MAIL_BLOCKED_DOMAINS` sigue bloqueando igual — hay test
 * para eso.
 */
export const ENV_PERMITIR_RESERVADOS = 'MAIL_ALLOW_RESERVED_DOMAINS';

/**
 * Dominios que por NORMA no resuelven nunca.
 *
 *   test, example, invalid, localhost  -> RFC 2606 y RFC 6761
 *   local                              -> RFC 6762 (mDNS), solo enlace local
 *   example.com / .net / .org          -> RFC 2606, reservados para documentar
 *
 * `demo-andina.test` cae aca por `test`, sin necesidad de configurar nada: la
 * cuenta demo esta protegida en una instalacion recien clonada, que es la
 * unica forma de que la proteccion sirva de algo.
 */
export const DOMINIOS_RESERVADOS_POR_NORMA: readonly string[] = [
  'test',
  'example',
  'invalid',
  'localhost',
  'local',
  'example.com',
  'example.net',
  'example.org',
];

/**
 * La direccion desnuda, sin el nombre para mostrar.
 *
 * `Central <admin@demo-andina.test>` tiene que quedar en
 * `admin@demo-andina.test`: si no se saca el `>` final, el dominio calculado es
 * `demo-andina.test>`, que no calza con ninguna regla y la direccion sale a
 * internet. Es un fallo ABIERTO, que es el unico que no podemos permitirnos
 * aca. Hoy `notifyEmail` se valida con `@IsEmail()` y no admite esa forma, pero
 * la proteccion no puede depender de que ninguna ruta futura la acepte.
 */
function direccionDesnuda(crudo: string): string {
  const conNombre = /<([^<>]*)>[^<>]*$/.exec(crudo);
  return (conNombre?.[1] ?? crudo).trim().toLowerCase();
}

/**
 * El dominio de una direccion, o null si no la tiene.
 *
 * `lastIndexOf` y no `split('@')`: la parte local de una direccion puede llevar
 * arrobas si va entre comillas, y lo que importa siempre es lo que va despues
 * de la ULTIMA. Partir por la primera dejaria pasar `"a@demo"@ejemplo.test`.
 */
export function dominioDe(email: string): string | null {
  const direccion = direccionDesnuda(email);
  const arroba = direccion.lastIndexOf('@');
  if (arroba <= 0 || arroba === direccion.length - 1) return null;
  const dominio = normalizarDominio(direccion.slice(arroba + 1));
  return dominio.length === 0 ? null : dominio;
}

/** Minusculas, sin espacios, sin el arroba de adelante y sin puntos al borde. */
export function normalizarDominio(crudo: string): string {
  return crudo
    .trim()
    .toLowerCase()
    .replace(/^@+/, '')
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
}

/** Parte "a.cl, b.cl; c.cl" en una lista limpia y sin repetidos. */
export function parsearDominios(crudo: string | undefined | null): string[] {
  if (crudo === undefined || crudo === null) return [];
  const dominios = crudo
    .split(/[,;\s]+/)
    .map(normalizarDominio)
    .filter((dominio) => dominio.length > 0);
  return [...new Set(dominios)];
}

/**
 * La lista efectiva a partir del entorno.
 *
 * Con el entorno vacio devuelve los reservados por norma: el default protege
 * sin que nadie configure nada. La variable de entorno SUMA, nunca reemplaza.
 */
export function resolverDominiosNoDespachables(
  entorno: Record<string, string | undefined>,
): string[] {
  const permitirReservados = entorno[ENV_PERMITIR_RESERVADOS] === 'true';
  const base = permitirReservados ? [] : DOMINIOS_RESERVADOS_POR_NORMA;
  return [...new Set([...base, ...parsearDominios(entorno[ENV_DOMINIOS_BLOQUEADOS])])];
}

/**
 * La entrada de la lista que bloquea a este dominio, o null si ninguna.
 *
 * Devuelve la REGLA y no un booleano porque es lo unico que se puede escribir
 * en el log sin filtrar la direccion del destinatario: contesta "¿por que no
 * salio?" con un valor que puso el propio operador en la configuracion.
 *
 * Coincide el dominio exacto y sus SUBDOMINIOS, nunca por pedazo de texto:
 * `demo-andina.test` cae bajo `test`, pero `mitest.cl` y `test.cl` NO. Un
 * `includes()` aca bloquearia correos legitimos y el sintoma —"a este cliente
 * no le llega el informe y a los demas si"— es carisimo de diagnosticar.
 *
 * Una entrada vacia se ignora, y conviene ser exacto sobre por que: NO es que
 * hoy rompa algo. Con la lista que arma `parsearDominios` el caso no llega —
 * filtra los vacios— y ademas `normalizarDominio` saca el punto del final, asi
 * que `endsWith('.')` tampoco tiene a quien enganchar. Es un descarte
 * DEFENSIVO: una lista armada a mano, o un `parsearDominios` que un dia deje de
 * filtrar, haria que la entrada vacia calzara por igualdad con un dominio vacio
 * y devolviera `''` como regla. Una regla vacia en el log no contesta nada, y
 * una lista de bloqueo que empieza a calzar sola es la unica falla de este
 * archivo que apagaria el correo del producto entero. Cuesta una linea.
 */
export function reglaQueBloquea(dominio: string, bloqueados: readonly string[]): string | null {
  for (const bloqueado of bloqueados) {
    if (bloqueado.length === 0) continue;
    if (dominio === bloqueado || dominio.endsWith(`.${bloqueado}`)) return bloqueado;
  }
  return null;
}

/** Si un dominio cae bajo alguno de los bloqueados. */
export function esDominioBloqueado(dominio: string, bloqueados: readonly string[]): boolean {
  return reglaQueBloquea(dominio, bloqueados) !== null;
}

/**
 * Si a esta direccion se le puede escribir.
 *
 * Una direccion sin dominio NO es despachable: no hay a donde mandarla y el
 * proveedor la rechaza igual. Se decide aca y no se deja pasar "por si acaso".
 */
export function esDespachable(email: string, bloqueados: readonly string[]): boolean {
  const dominio = dominioDe(email);
  if (dominio === null) return false;
  return !esDominioBloqueado(dominio, bloqueados);
}

/**
 * Parte una lista de destinatarios en los que se despachan y los que no.
 *
 * Devuelve las DOS mitades a proposito. Quien llama necesita la suprimida para
 * dos cosas distintas: contarla en el log (solo el numero, nunca la direccion)
 * y distinguir "esta empresa no tiene a quien escribirle" de "esta empresa solo
 * tiene direcciones de prueba". Son dos problemas con dos arreglos distintos.
 *
 * La cola suprime igual, una por una. Esto existe para quien tiene que decidir
 * ANTES de escribir su propia bitacora —el despacho del informe escribe en
 * `report_deliveries` antes de encolar— y necesita no anotar como enviado algo
 * que la cola va a descartar.
 */
export function separarPorDominio<T extends { readonly email: string }>(
  destinatarios: readonly T[],
  bloqueados: readonly string[],
): { despachables: T[]; suprimidos: T[] } {
  const despachables: T[] = [];
  const suprimidos: T[] = [];
  for (const destinatario of destinatarios) {
    if (esDespachable(destinatario.email, bloqueados)) despachables.push(destinatario);
    else suprimidos.push(destinatario);
  }
  return { despachables, suprimidos };
}
