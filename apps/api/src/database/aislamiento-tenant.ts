/**
 * Vocabulario comun de las dos pruebas de aislamiento por empresa (#218).
 *
 * El producto es una sola base compartida por muchas empresas de seguridad
 * privada. El aislamiento lo sostiene RLS, y RLS se declara tabla por tabla en
 * su propia migracion: nadie comprueba que el CONJUNTO siga siendo coherente.
 * En una sola semana entraron once tablas nuevas. Por eso la comprobacion no
 * puede apoyarse en una lista escrita a mano —lo que se escribe a mano se
 * olvida— sino en descubrir las tablas y exigirle a cada una lo mismo.
 *
 * Aca vive lo que las dos pruebas comparten:
 *
 *   - `TABLAS_SIN_TENANT_ID`, la unica lista blanca, con el motivo escrito;
 *   - los constructores de la consulta que hace el A/B sin depender de que
 *     haya datos sembrados.
 *
 * Son funciones puras a proposito: la prueba estatica las ejercita sin base
 * (`aislamiento-tenant.spec.ts`) y la de integracion las corre contra
 * PostgreSQL de verdad (`aislamiento-tenant.integration.spec.ts`).
 */

/** La columna que marca a que empresa pertenece una fila. */
export const COLUMNA_TENANT = 'tenant_id';

/** Excepcion declarada: tabla que no lleva `tenant_id`, con su motivo. */
export interface ExcepcionSinTenantId {
  /**
   * Por que esta tabla no lleva `tenant_id`. Se imprime en el fallo del test,
   * asi que se escribe para el que llega en seis meses sin contexto.
   */
  motivo: string;
  /**
   * Columna por la que SI se aisla, cuando el aislamiento existe con otro
   * nombre. `tenants` se aisla por su propio `id`. Sin este campo la tabla
   * queda fuera de la prueba A/B: es una tabla de la PLATAFORMA, comun a todas
   * las empresas, y no hay nada que aislar.
   */
  columnaDeAislamiento?: string;
}

/**
 * Las unicas tablas que pueden no tener `tenant_id`. Agregar una entrada aca
 * es una decision, no un atajo: si la tabla guarda datos de una empresa, la
 * respuesta correcta es ponerle `tenant_id` y RLS, no anotarla.
 *
 * Los motivos estan copiados de la migracion que crea cada tabla, que es donde
 * se discutieron.
 */
export const TABLAS_SIN_TENANT_ID = new Map<string, ExcepcionSinTenantId>([
  [
    'tenants',
    {
      motivo:
        'Es la empresa misma: se aisla por su propio id, no por una columna que ' +
        'apunte a otra fila. La politica tenants_isolation compara id con app_tenant_id().',
      columnaDeAislamiento: 'id',
    },
  ],
  [
    'users',
    {
      motivo:
        'Una persona puede trabajar en varias empresas, asi que la fila no pertenece ' +
        'a ninguna: se aisla por memberships (politica users_isolation). Por eso no ' +
        'entra en la prueba A/B por columna, que supone una empresa por fila.',
    },
  ],
  [
    'roles',
    {
      motivo:
        'Catalogo de roles del producto, igual para todas las empresas. Solo lectura ' +
        'para el rol de la aplicacion; no guarda ningun dato de nadie.',
    },
  ],
  [
    'permissions',
    {
      motivo: 'Catalogo de permisos del producto, comun a todas las empresas.',
    },
  ],
  [
    'role_permissions',
    {
      motivo: 'Cruce entre los dos catalogos anteriores: no contiene datos de empresas.',
    },
  ],
  [
    'platform_memberships',
    {
      motivo:
        'Membresia de PLATAFORMA (SUPERADMIN). Por definicion no pertenece a ninguna ' +
        'empresa y la consulta alguien que no tiene contexto de tenant abierto.',
    },
  ],
  [
    'subscription_plans',
    {
      motivo: 'Catalogo comercial de la plataforma: los planes son los mismos para todos.',
    },
  ],
  [
    'billing_tiers',
    {
      motivo: 'Tramos de precio de la plataforma, comunes a todos los planes.',
    },
  ],
  [
    'plan_feature_flags',
    {
      motivo:
        'Que modulos incluye cada PLAN. Es el techo comercial de la plataforma; lo que ' +
        'una empresa tiene concedido vive en tenant_feature_grants, que si lleva tenant_id.',
    },
  ],
  [
    'platform_rules',
    {
      motivo:
        'Reglas por defecto del producto, escalon mas alto de la cascada. Se escribe solo ' +
        'por platform_set_rules(), que exige SUPERADMIN.',
    },
  ],
  [
    'platform_config_change_log',
    {
      motivo:
        'Historial de cambios del nivel PLATAFORMA. El historial por empresa es ' +
        'config_change_log, que si lleva tenant_id y RLS.',
    },
  ],
  [
    'tenant_deletions',
    {
      motivo:
        'Habla SOBRE una empresa (target_tenant_id) en vez de pertenecer a ella, y debe ' +
        'sobrevivir al purge de esa empresa: es la prueba juridica de que el borrado se ' +
        'pidio y se ejecuto (ley 21.719). La consulta el SUPERADMIN, sin contexto de tenant.',
    },
  ],
]);

/**
 * Tabla de control de TypeORM (`migrationsTableName` en data-source.ts). No es
 * del producto y no la crea ninguna migracion, asi que se descuenta antes de
 * exigirle nada.
 */
export const TABLA_DE_CONTROL_TYPEORM = 'schema_migrations';

/** Devuelve la columna por la que se aisla la tabla, o null si no se aisla. */
export function columnaDeAislamiento(tabla: string, tieneTenantId: boolean): string | null {
  if (tieneTenantId) return COLUMNA_TENANT;
  return TABLAS_SIN_TENANT_ID.get(tabla)?.columnaDeAislamiento ?? null;
}

export interface ColumnaDeTabla {
  nombre: string;
  /** Tipo tal cual lo escribe format_type(): 'uuid', 'timestamp with time zone'... */
  tipo: string;
}

export interface PoliticaDeTabla {
  nombre: string;
  /** false = RESTRICTIVE: se suman con AND en vez de con OR. */
  permisiva: boolean;
  /** 'ALL', 'SELECT', 'INSERT', 'UPDATE' o 'DELETE', como en pg_policies.cmd. */
  comando: string;
  /** El USING de la politica. null cuando se omitio: entonces no filtra nada. */
  usando: string | null;
  /**
   * El WITH CHECK. null cuando se omitio; en ese caso PostgreSQL reutiliza el
   * USING para validar lo que se escribe, y por eso `expresionDeEscritura`
   * hace lo mismo en vez de tratarlo como "sin restriccion".
   */
  conCheck: string | null;
}

/** Comilla un identificador para meterlo en SQL: `tabla` -> `"tabla"`. */
function entrecomillar(identificador: string): string {
  return `"${identificador.replace(/"/g, '""')}"`;
}

/** Las politicas que deciden que FILAS se ven al leer. */
export function politicasDeLectura(politicas: PoliticaDeTabla[]): PoliticaDeTabla[] {
  return politicas.filter(
    (politica) => politica.comando === 'ALL' || politica.comando === 'SELECT',
  );
}

/** Las politicas que deciden que filas se pueden DEJAR escritas. */
export function politicasDeEscritura(politicas: PoliticaDeTabla[]): PoliticaDeTabla[] {
  return politicas.filter(
    (politica) =>
      politica.comando === 'ALL' ||
      politica.comando === 'INSERT' ||
      politica.comando === 'UPDATE',
  );
}

/**
 * La fila que se le ofrece a la politica para evaluarla: la columna de
 * aislamiento vale el uuid que llega por parametro y TODO lo demas es NULL.
 *
 * El alias lleva el nombre de la tabla para que el USING resuelva tanto
 * `tenant_id` como `mi_tabla.tenant_id`.
 */
export function filaSintetica(
  tabla: string,
  columnas: ColumnaDeTabla[],
  columnaAislamiento: string,
): string {
  const campos = columnas.map((columna) =>
    columna.nombre === columnaAislamiento
      ? `$1::${columna.tipo} AS ${entrecomillar(columna.nombre)}`
      : `NULL::${columna.tipo} AS ${entrecomillar(columna.nombre)}`,
  );
  return `(SELECT ${campos.join(', ')}) AS ${entrecomillar(tabla)}`;
}

/**
 * Combina un juego de politicas como lo hace PostgreSQL: basta UNA permisiva
 * verdadera, y ninguna restrictiva puede ser falsa.
 *
 * Una expresion ausente no filtra: cuenta como verdadera. Se representa tal
 * cual —y no se disimula— porque justamente ese es el agujero que hay que ver.
 * Sin ninguna permisiva no pasa nada: RLS niega por defecto.
 */
function combinar(
  politicas: PoliticaDeTabla[],
  expresionDe: (politica: PoliticaDeTabla) => string | null,
): string {
  const comoBooleano = (politica: PoliticaDeTabla): string => {
    const expresion = expresionDe(politica);
    // NULL no es "verdadero" para RLS: la fila no pasa. coalesce lo deja explicito.
    return expresion === null ? 'true' : `coalesce((${expresion}), false)`;
  };

  const permisivas = politicas.filter((politica) => politica.permisiva);
  const restrictivas = politicas.filter((politica) => !politica.permisiva);

  const alguna =
    permisivas.length === 0 ? 'false' : permisivas.map(comoBooleano).join(' OR ');

  return [`(${alguna})`, ...restrictivas.map((politica) => `(${comoBooleano(politica)})`)].join(
    ' AND ',
  );
}

/**
 * Traduce el juego de politicas a la expresion booleana que PostgreSQL aplica
 * al LEER.
 */
export function expresionDeVisibilidad(politicas: PoliticaDeTabla[]): string {
  return combinar(politicasDeLectura(politicas), (politica) => politica.usando);
}

/**
 * Lo mismo para lo que se ESCRIBE. Sirve para la otra mitad del aislamiento:
 * que una empresa no pueda dejar una fila con el tenant de otra.
 */
export function expresionDeEscritura(politicas: PoliticaDeTabla[]): string {
  return combinar(politicasDeEscritura(politicas), (politica) => politica.conCheck ?? politica.usando);
}

/**
 * La consulta del A/B. Se corre con el rol de la aplicacion y un contexto de
 * empresa abierto, pasando por parametro el tenant de la fila imaginaria:
 *
 *   - con el tenant propio tiene que dar `true` —si no, la prueba estaria
 *     pasando sin comprobar nada—;
 *   - con el tenant de la otra empresa, `false`;
 *   - sin contexto de empresa, `false`.
 *
 * No inserta ni una fila, asi que sirve igual para las tablas que el seed
 * nunca llena. Eso no es un detalle: hoy 45 de las 53 tablas con `tenant_id`
 * quedan vacias despues del seed, y sobre esas 45 la prueba A/B por datos pasa
 * sin comprobar absolutamente nada.
 */
export function consultaDeVisibilidad(
  tabla: string,
  columnas: ColumnaDeTabla[],
  politicas: PoliticaDeTabla[],
  columnaAislamiento: string,
): string {
  return [
    `SELECT ${expresionDeVisibilidad(politicas)} AS visible`,
    `FROM ${filaSintetica(tabla, columnas, columnaAislamiento)}`,
  ].join('\n');
}

/** Igual que la anterior, pero para lo que la empresa puede DEJAR escrito. */
export function consultaDeEscritura(
  tabla: string,
  columnas: ColumnaDeTabla[],
  politicas: PoliticaDeTabla[],
  columnaAislamiento: string,
): string {
  return [
    `SELECT ${expresionDeEscritura(politicas)} AS aceptada`,
    `FROM ${filaSintetica(tabla, columnas, columnaAislamiento)}`,
  ].join('\n');
}
