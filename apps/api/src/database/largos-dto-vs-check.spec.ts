import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guardia sobre los CHECK que miden el largo RECORTADO de una columna.
 *
 * El defecto que cubre ya llego dos veces a produccion por el mismo camino: la
 * validacion de entrada y la restriccion de la tabla miden cosas distintas, y la
 * unica que rechaza termina siendo PostgreSQL — cuya forma de rechazar es un
 * 500, no un 400.
 *
 *   - #242: `privacy_policy_url ~* '...{4,500}'`, un limite que el motor de
 *     expresiones regulares ni siquiera compila.
 *   - Su hermano: `length(trim(body)) BETWEEN 100 AND 20000` contra un
 *     `@MinLength(100)` que contaba los espacios de las puntas. Un aviso de 100
 *     caracteres con un espacio a cada lado llegaba a la base midiendo 98.
 *
 * Los tests unitarios no lo cazan porque mockean `manager.query`: un CHECK vive
 * dentro de PostgreSQL. Lo que si se puede comprobar sin base es que, para cada
 * columna cuyo CHECK mide recortado, alguien recorte ANTES —y que los topes que
 * declara el DTO sean los mismos que mide la restriccion.
 *
 * NO cubre la variante espejo (CHECK que mide SIN recortar + servicio que
 * recorta antes del INSERT, como `tags.uid`): ahi el nombre de la columna no
 * alcanza para saber quien recorta. Esos casos estan anotados en el PR.
 */
const CARPETA_MIGRACIONES = join(__dirname, 'migrations');
const RAIZ_API = join(__dirname, '..');

/** `length(trim(col)) BETWEEN a AND b` | `>= a` | `> a`, tal cual se escribe en las migraciones. */
const CHECK_RECORTADO =
  /length\(\s*trim\(\s*([a-z_]+)\s*\)\s*\)\s*(?:BETWEEN\s+(\d+)\s+AND\s+(\d+)|>=\s*(\d+)|>\s*(\d+))/gi;

interface Restriccion {
  readonly archivo: string;
  readonly columna: string;
  readonly min: number;
  readonly max: number | null;
}

/** Como se garantiza que lo validado y lo guardado midan lo mismo. */
type Cobertura =
  /** Un DTO de esta API recorta antes de validar. Se comprueba abajo. */
  | { readonly via: 'dto'; readonly archivo: string; readonly campo: string; readonly nota?: string }
  /** El servicio recorta (o normaliza y acota) antes del INSERT. */
  | { readonly via: 'servicio'; readonly donde: string; readonly nota: string }
  /** El valor no puede traer espacios en las puntas, asi que no hay nada que recortar. */
  | { readonly via: 'imposible'; readonly nota: string }
  /** Se valida fuera de apps/api (esquema zod de @sentrycore/shared). */
  | { readonly via: 'externo'; readonly donde: string; readonly nota: string };

/**
 * Una entrada por CHECK que mide recortado. Si agregas uno nuevo y no lo
 * anotas aca, este archivo falla: es deliberado. La pregunta "¿quien recorta
 * antes de que lo haga PostgreSQL?" hay que contestarla al escribir la
 * migracion, no cuando la API devuelva 500 en produccion.
 */
const COBERTURA: Record<string, Cobertura> = {
  '1722438000000-EnableTenantRls.ts:reason': {
    via: 'servicio',
    donde: 'platform-data/support-access.service.ts:52',
    nota: 'recorta y vuelve a exigir el minimo de 10 con BadRequestException',
  },
  '1723820400000-CreateFieldEvents.ts:text': {
    via: 'dto',
    archivo: 'guard/dto/report-event.dto.ts',
    campo: 'text',
    nota: 'recorta y, si queda vacio, lo trata como ausente para no rechazar un panico',
  },
  '1724166000000-CreateTenantDeletions.ts:reason': {
    via: 'dto',
    archivo: 'platform-data/dto/schedule-deletion.dto.ts',
    campo: 'reason',
  },
  '1724511600000-CreateTrackAndConsent.ts:policy_version': {
    via: 'dto',
    archivo: 'geo/dto/grant-consent.dto.ts',
    campo: 'policyVersion',
  },
  '1724598000000-CreateAuditLog.ts:action': {
    via: 'servicio',
    donde: 'audit/audit.service.ts',
    nota: 'la accion la escribe la API con literales del catalogo, no llega de un cuerpo HTTP',
  },
  '1724857200000-CreateTenantBranding.ts:commercial_name': {
    via: 'externo',
    donde: 'packages/shared/src/branding.ts',
    nota: 'tenantBrandingSchema; el recorte va en el esquema zod, fuera de este workspace',
  },
  '1724857200000-CreateTenantBranding.ts:mail_from_name': {
    via: 'externo',
    donde: 'packages/shared/src/branding.ts',
    nota: 'idem commercial_name',
  },
  '1724943600000-CreateChecklists.ts:name': {
    via: 'dto',
    archivo: 'checklists/dto/checklist-template.dto.ts',
    campo: 'name',
  },
  '1724943600000-CreateChecklists.ts:label': {
    via: 'dto',
    archivo: 'checklists/dto/checklist-template.dto.ts',
    campo: 'label',
  },
  '1724943600000-CreateChecklists.ts:value': {
    via: 'servicio',
    donde: 'checklists/checklists.service.ts:523',
    nota: 'interpretar() recorta y rechaza el valor vacio antes del INSERT',
  },
  '1725030000000-CreateDeviceTokens.ts:token': {
    via: 'imposible',
    nota: 'el @Matches de RegisterDeviceDto.token prohibe el espacio (rango \\x21-\\x7e)',
  },
  '1725030000000-CreateDeviceTokens.ts:app_version': {
    via: 'dto',
    archivo: 'push/dto/register-device.dto.ts',
    campo: 'appVersion',
  },
  '1725462098000-CreatePatrolAlerts.ts:attended_comment': {
    via: 'dto',
    archivo: 'escalation/alertas-ronda.dto.ts',
    campo: 'comment',
  },
  '1725472800000-CreateConsentPolicies.ts:body': {
    via: 'dto',
    archivo: 'consent/dto/publish-policy.dto.ts',
    campo: 'body',
  },
  '1725472810000-CreateSiteHolidays.ts:name': {
    via: 'dto',
    archivo: 'admin/dto/site-calendar.dto.ts',
    campo: 'name',
  },
  '1725559200000-CreateAppCrashReports.ts:app_version': {
    via: 'imposible',
    nota: 'el @Matches de ReportCrashDto.appVersion prohibe el espacio',
  },
  '1725559200000-CreateAppCrashReports.ts:device_model': {
    via: 'dto',
    archivo: 'observability/dto/report-crash.dto.ts',
    campo: 'deviceModel',
  },
  '1725559200000-CreateAppCrashReports.ts:android_version': {
    via: 'dto',
    archivo: 'observability/dto/report-crash.dto.ts',
    campo: 'androidVersion',
  },
  '1725559200000-CreateAppCrashReports.ts:error_name': {
    via: 'servicio',
    donde: 'observability/crash-reporting.service.ts:166',
    nota: 'depurarEtiqueta() recorta y acota a 120, con respaldo "Error" si queda vacio',
  },
  '1725559210000-CreateConfigChangeLog.ts:param_key': {
    via: 'servicio',
    donde: '1725559210000-CreateConfigChangeLog.ts:195 (app_log_config_change)',
    nota: 'lo escribe un trigger con las llaves del JSONB de reglas, no un cuerpo HTTP (dos tablas, misma columna)',
  },
};

function leerRestricciones(): Restriccion[] {
  const encontradas = new Map<string, Restriccion>();
  for (const archivo of readdirSync(CARPETA_MIGRACIONES).filter(
    (f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'),
  )) {
    const sql = readFileSync(join(CARPETA_MIGRACIONES, archivo), 'utf8');
    for (const hallazgo of sql.matchAll(CHECK_RECORTADO)) {
      const [, columna, entreMin, entreMax, mayorIgual, mayor] = hallazgo;
      const min = Number(entreMin ?? mayorIgual ?? (mayor !== undefined ? Number(mayor) + 1 : 0));
      // Una misma columna puede repetirse dentro del archivo (dos tablas
      // hermanas); la clave las junta a proposito, el arreglo es el mismo.
      encontradas.set(`${archivo}:${columna}`, {
        archivo,
        columna: columna!,
        min,
        max: entreMax !== undefined ? Number(entreMax) : null,
      });
    }
  }
  return [...encontradas.values()];
}

/**
 * Los decoradores de un campo: desde el final del campo anterior hasta la linea
 * que lo declara. Asi el docblock, por largo que sea, no se lleva por delante el
 * `@Transform` de otro campo ni deja fuera el propio.
 */
function bloquesDelCampo(fuente: string, campo: string): string[] {
  const lineas = fuente.split('\n');
  const esDeclaracion = (linea: string) => /^\s*[A-Za-z_$][\w$]*[!?]?\s*:\s*.*;\s*$/.test(linea);
  const bloques: string[] = [];

  lineas.forEach((linea, indice) => {
    if (!new RegExp(`^\\s*${campo}[!?]?\\s*:`).test(linea)) return;
    let inicio = indice - 1;
    while (inicio >= 0 && !esDeclaracion(lineas[inicio]!)) inicio -= 1;
    bloques.push(lineas.slice(inicio + 1, indice + 1).join('\n'));
  });

  return bloques;
}

/** Topes que declara el validador. `@Length(a, b)` cuenta como min y max. */
function topesDelBloque(bloque: string): { min: number | null; max: number | null } {
  const numero = (texto: string) => Number(texto.replace(/_/g, ''));
  const largo = /@Length\(\s*([\d_]+)\s*,\s*([\d_]+)\s*\)/.exec(bloque);
  if (largo) return { min: numero(largo[1]!), max: numero(largo[2]!) };
  const minimo = /@MinLength\(\s*([\d_]+)/.exec(bloque);
  const maximo = /@MaxLength\(\s*([\d_]+)/.exec(bloque);
  return {
    min: minimo ? numero(minimo[1]!) : null,
    max: maximo ? numero(maximo[1]!) : null,
  };
}

describe('largos: lo que valida el DTO vs lo que mide el CHECK', () => {
  const restricciones = leerRestricciones();

  it('encuentra los CHECK que miden recortado', () => {
    // Si esto baja de golpe es que el regex dejo de reconocer la forma en que
    // se escriben los CHECK, no que el problema se haya arreglado solo.
    expect(restricciones.length).toBeGreaterThanOrEqual(20);
  });

  it('cada CHECK que mide recortado declara quien recorta antes', () => {
    const sinAnotar = restricciones
      .map((r) => `${r.archivo}:${r.columna}`)
      .filter((clave) => !(clave in COBERTURA));
    expect(sinAnotar).toEqual([]);
  });

  it('no quedan entradas anotadas de un CHECK que ya no existe', () => {
    const vivas = new Set(restricciones.map((r) => `${r.archivo}:${r.columna}`));
    expect(Object.keys(COBERTURA).filter((clave) => !vivas.has(clave))).toEqual([]);
  });

  it('todo campo anotado como recortado en el DTO lo recorta de verdad', () => {
    const faltantes: string[] = [];
    for (const [clave, cobertura] of Object.entries(COBERTURA)) {
      if (cobertura.via !== 'dto') continue;
      const fuente = readFileSync(join(RAIZ_API, cobertura.archivo), 'utf8');
      const bloques = bloquesDelCampo(fuente, cobertura.campo);
      if (bloques.length === 0) {
        faltantes.push(`${clave}: no existe el campo ${cobertura.campo} en ${cobertura.archivo}`);
        continue;
      }
      // TODAS las clases del archivo que declaran el campo: el DTO de creacion
      // y el de actualizacion escriben en la misma columna.
      bloques.forEach((bloque, indice) => {
        if (!bloque.includes('@Transform') || !bloque.includes('.trim()')) {
          faltantes.push(
            `${clave}: ${cobertura.archivo}#${cobertura.campo}[${indice}] valida sin recortar`,
          );
        }
      });
    }
    expect(faltantes).toEqual([]);
  });

  it('los topes del DTO son los mismos que mide el CHECK', () => {
    const desajustados: string[] = [];
    for (const restriccion of restricciones) {
      const cobertura = COBERTURA[`${restriccion.archivo}:${restriccion.columna}`];
      if (!cobertura || cobertura.via !== 'dto') continue;
      const fuente = readFileSync(join(RAIZ_API, cobertura.archivo), 'utf8');
      for (const [indice, bloque] of bloquesDelCampo(fuente, cobertura.campo).entries()) {
        const topes = topesDelBloque(bloque);
        const donde = `${cobertura.archivo}#${cobertura.campo}[${indice}]`;
        if (topes.min !== null && topes.min !== restriccion.min) {
          faltaMin(desajustados, donde, restriccion, topes.min);
        }
        // Un CHECK sin tope superior no obliga al DTO a no tenerlo: el DTO
        // acota por su cuenta y eso nunca produce un 500.
        if (restriccion.max !== null && topes.max !== null && topes.max !== restriccion.max) {
          desajustados.push(
            `${donde}: el DTO acepta hasta ${topes.max} y el CHECK hasta ${restriccion.max}`,
          );
        }
      }
    }
    expect(desajustados).toEqual([]);
  });
});

function faltaMin(
  acumulador: string[],
  donde: string,
  restriccion: Restriccion,
  minDto: number,
): void {
  acumulador.push(
    `${donde}: el DTO exige ${minDto} y el CHECK exige ${restriccion.min} ` +
      `(${restriccion.archivo}, columna ${restriccion.columna})`,
  );
}
