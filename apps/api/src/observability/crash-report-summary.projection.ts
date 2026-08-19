import type { CrashReportSummaryGroupDto } from './dto/crash-report-summary.dto';

/** Fallbacks fijos: nunca incorporan una parte del valor rechazado. */
export const ERROR_NO_IDENTIFICADO = 'Error no identificado';
export const VERSION_APP_NO_IDENTIFICADA = 'Versión de app no identificada';
export const MODELO_NO_IDENTIFICADO = 'Modelo no identificado';
export const ANDROID_NO_IDENTIFICADO = 'Versión no identificada';

const LARGO_MAX_ERROR_NAME = 120;
const LARGO_MAX_VERSION_APP = 32;
const LARGO_MAX_MODELO = 64;

/**
 * Lista cerrada basada en los tipos del runtime y en las clases observadas en
 * este repositorio. Un sufijo `Error` no demuestra que sea una clase: tambien
 * permitiria disfrazar un nombre como `JuanPerezError`.
 */
export const ERROR_NAMES_PERMITIDOS = [
  'Error',
  'AggregateError',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
  'NfcBridgeError',
  'QueryFailedError',
  'java.lang.IllegalStateException',
] as const;
const ERROR_NAMES_PERMITIDOS_SET = new Set<string>(ERROR_NAMES_PERMITIDOS);

/**
 * Formas cerradas de release: semver de tres segmentos o calver `20YY.MM(.DD)`.
 * Los prereleases usan solo canales conocidos (o un numero) y el build es
 * numerico; asi tampoco se puede esconder texto libre en un sufijo.
 */
export const PATRON_VERSION_APP =
  /^(?=.{1,32}$)(?:(?:(?:0|[1-9]\d{0,3})\.){2}(?:0|[1-9]\d{0,3})|20\d{2}\.(?:0[1-9]|1[0-2])(?:\.(?:0[1-9]|[12]\d|3[01]))?)(?:-(?:\d{1,6}|(?:alpha|beta|rc|dev|e2e|preview|canary|staging)(?:[.-]?\d{1,4})?))?(?:\+\d{1,10})?$/;

/**
 * Catalogo finito de modelos respaldados por el contrato, pruebas o evidencia
 * del repositorio. Ni siquiera un regex anclado por fabricante garantiza que
 * la cola no sea un identificador (`SM-JUAN123`, `Lenovo EMP-12345`). Un modelo
 * nuevo cae al fallback hasta que se agregue deliberadamente con evidencia y
 * un test. Se pierde detalle diagnostico de equipos desconocidos a cambio de
 * que texto libre nunca llegue al navegador.
 */
export const DEVICE_MODELS_PERMITIDOS = [
  'Redmi 9A',
  'SM-A145M',
  'SM-S901B',
  'Pixel 8 Pro',
  'Pixel Fold',
  'sdk_gphone64_x86_64',
  'moto g power',
  'moto g35 5G',
  'Moto G54',
  'Lenovo TB-X606F',
] as const;
const DEVICE_MODELS_PERMITIDOS_SET = new Set<string>(DEVICE_MODELS_PERMITIDOS);

/** Android numerico: `10`, `13`, `14` y, para equipos viejos, `4.4.4`. */
export const PATRON_VERSION_ANDROID =
  /^(?:[1-9]|[1-9][0-9])(?:\.(?:0|[1-9][0-9]?)){0,2}$/;

export interface CrashReportSummaryRawGroup {
  readonly errorName: unknown;
  readonly appVersion: unknown;
  readonly deviceModel: unknown;
  readonly androidVersion: unknown;
  readonly total: unknown;
  readonly fatales: unknown;
}

interface GrupoAcumulado {
  errorName: string;
  appVersion: string;
  deviceModel: string;
  androidVersion: string;
  total: number;
  fatales: number;
}

export function errorNameSeguro(valor: unknown): string {
  if (typeof valor !== 'string') return ERROR_NO_IDENTIFICADO;
  const limpio = valor.trim();
  return limpio.length >= 1
    && limpio.length <= LARGO_MAX_ERROR_NAME
    && ERROR_NAMES_PERMITIDOS_SET.has(limpio)
    ? limpio
    : ERROR_NO_IDENTIFICADO;
}

export function appVersionSegura(valor: unknown): string {
  if (typeof valor !== 'string') return VERSION_APP_NO_IDENTIFICADA;
  return valor.length <= LARGO_MAX_VERSION_APP
    && PATRON_VERSION_APP.test(valor)
    ? valor
    : VERSION_APP_NO_IDENTIFICADA;
}

export function deviceModelSeguro(valor: unknown): string {
  if (typeof valor !== 'string') return MODELO_NO_IDENTIFICADO;
  const limpio = valor.trim();
  return limpio.length <= LARGO_MAX_MODELO && DEVICE_MODELS_PERMITIDOS_SET.has(limpio)
    ? limpio
    : MODELO_NO_IDENTIFICADO;
}

export function androidVersionSegura(valor: unknown): string {
  if (typeof valor !== 'string') return ANDROID_NO_IDENTIFICADO;
  const limpio = valor.trim();
  return PATRON_VERSION_ANDROID.test(limpio) ? limpio : ANDROID_NO_IDENTIFICADO;
}

/**
 * Proyecta la lista cerrada y fusiona grupos que terminan con la misma clave
 * segura. Sin la fusion, cincuenta etiquetas libres distintas podrian aparecer
 * como cincuenta filas identicas de "no identificado" y perder sus conteos al
 * limitar la respuesta.
 */
export function proyectarGruposResumen(
  crudos: readonly CrashReportSummaryRawGroup[],
  limite: number,
): CrashReportSummaryGroupDto[] {
  const fusionados = new Map<string, GrupoAcumulado>();

  for (const crudo of crudos) {
    const total = conteoSeguro(crudo.total);
    if (total === 0) continue;

    const grupo: GrupoAcumulado = {
      errorName: errorNameSeguro(crudo.errorName),
      appVersion: appVersionSegura(crudo.appVersion),
      deviceModel: deviceModelSeguro(crudo.deviceModel),
      androidVersion: androidVersionSegura(crudo.androidVersion),
      total,
      fatales: Math.min(conteoSeguro(crudo.fatales), total),
    };
    const clave = JSON.stringify([
      grupo.errorName,
      grupo.appVersion,
      grupo.deviceModel,
      grupo.androidVersion,
    ]);
    const existente = fusionados.get(clave);

    if (existente) {
      existente.total = sumaSegura(existente.total, grupo.total);
      existente.fatales = Math.min(
        existente.total,
        sumaSegura(existente.fatales, grupo.fatales),
      );
    } else {
      fusionados.set(clave, grupo);
    }
  }

  return [...fusionados.values()]
    .sort((a, b) => b.total - a.total || b.fatales - a.fatales || compararClaves(a, b))
    .slice(0, Math.max(0, limite))
    .map((grupo) => ({ ...grupo }));
}

function conteoSeguro(valor: unknown): number {
  if (typeof valor !== 'string' && typeof valor !== 'number') return 0;
  const numero = Number(valor);
  return Number.isSafeInteger(numero) && numero >= 0 ? numero : 0;
}

function sumaSegura(a: number, b: number): number {
  return a > Number.MAX_SAFE_INTEGER - b ? Number.MAX_SAFE_INTEGER : a + b;
}

function compararClaves(a: GrupoAcumulado, b: GrupoAcumulado): number {
  const claveA = `${a.errorName}\u0000${a.appVersion}\u0000${a.deviceModel}\u0000${a.androidVersion}`;
  const claveB = `${b.errorName}\u0000${b.appVersion}\u0000${b.deviceModel}\u0000${b.androidVersion}`;
  return claveA < claveB ? -1 : claveA > claveB ? 1 : 0;
}
