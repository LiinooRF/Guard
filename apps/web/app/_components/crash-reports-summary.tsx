'use client';

import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

type FetchResumen = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json'>>;

const MAX_GRUPOS_RESUMEN = 50;
const MAX_DIAS_RESUMEN = 365;
export const ERROR_NO_IDENTIFICADO = 'Error no identificado';
export const VERSION_APP_NO_IDENTIFICADA = 'Versión de app no identificada';
export const MODELO_NO_IDENTIFICADO = 'Modelo no identificado';
export const ANDROID_NO_IDENTIFICADO = 'Versión no identificada';

// Lista cerrada basada en los tipos que produce el runtime y en las clases
// observadas en el producto. Un sufijo `Error` no basta: también podría ser un
// nombre de persona escrito para eludir la minimización.
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

// Expo publica un versionName semántico de tres partes. También se conserva el
// formato calendario que usa el contrato de resumen. Tokens alfanuméricos con
// un dígito no se consideran una versión.
export const PATRON_VERSION_APP =
  /^(?=.{1,32}$)(?:(?:(?:0|[1-9]\d{0,3})\.){2}(?:0|[1-9]\d{0,3})|20\d{2}\.(?:0[1-9]|1[0-2])(?:\.(?:0[1-9]|[12]\d|3[01]))?)(?:-(?:\d{1,6}|(?:alpha|beta|rc|dev|e2e|preview|canary|staging)(?:[.-]?\d{1,4})?))?(?:\+\d{1,10})?$/;

// Catálogo finito de modelos observados en el producto o fijados por su
// contrato. No se aceptan colas después de una marca: `Pixel JuanPerez123` y
// `SM-EMP12345` también podrían envolver un identificador personal. Incorporar
// un modelo nuevo exige añadir su etiqueta canónica en API, web y pruebas.
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
export const PATRON_VERSION_ANDROID =
  /^(?:[1-9]|[1-9][0-9])(?:\.(?:0|[1-9][0-9]?)){0,2}$/;

export interface GrupoCrashSeguro {
  errorName: string;
  appVersion: string;
  deviceModel: string;
  androidVersion: string;
  total: number;
  fatales: number;
}

export type EstadoResumenCrash =
  | { estado: 'apagado' }
  | { estado: 'no-incluido' }
  | { estado: 'apagado-desconocido' }
  | { estado: 'error' }
  | { estado: 'listo'; ventanaDias: number; grupos: GrupoCrashSeguro[] };

export type EstadoVistaResumenCrash = EstadoResumenCrash | { estado: 'cargando' };

/**
 * Lee el agregado técnico y proyecta solamente los campos permitidos para la
 * vista ADMIN (#225). Aunque el endpoint expone un DTO mínimo, la allowlist se
 * repite aquí como defensa en profundidad: ningún campo adicional se conserva
 * en el estado de React.
 */
export async function cargarResumenCrashes(
  apiUrl: string,
  fetchResumen: FetchResumen = fetch,
  signal?: AbortSignal,
): Promise<EstadoResumenCrash> {
  const opciones = opcionesDeLectura(signal);

  try {
    const respuesta = await fetchResumen(
      `${apiUrl}/observability/crash-reports/summary`,
      opciones,
    );

    if (respuesta.status === 404) {
      return await clasificarModuloNoDisponible(apiUrl, fetchResumen, opciones);
    }
    if (!respuesta.ok) return { estado: 'error' };

    const cuerpo = (await respuesta.json()) as unknown;
    return normalizarResumen(cuerpo) ?? { estado: 'error' };
  } catch {
    return { estado: 'error' };
  }
}

async function clasificarModuloNoDisponible(
  apiUrl: string,
  fetchResumen: FetchResumen,
  opciones: RequestInit,
): Promise<EstadoResumenCrash> {
  try {
    const respuesta = await fetchResumen(`${apiUrl}/features/admin`, opciones);
    if (!respuesta.ok) return { estado: 'apagado-desconocido' };

    const cuerpo = (await respuesta.json()) as unknown;
    if (!esRegistro(cuerpo) || !esRegistro(cuerpo.enabled) || !esRegistro(cuerpo.entitlements)) {
      return { estado: 'apagado-desconocido' };
    }

    const incluido = cuerpo.entitlements.crashReporting;
    const encendido = cuerpo.enabled.crashReporting;
    if (typeof incluido !== 'boolean' || typeof encendido !== 'boolean') {
      return { estado: 'apagado-desconocido' };
    }
    if (!incluido && encendido) return { estado: 'error' };
    if (!incluido) return { estado: 'no-incluido' };
    if (!encendido) return { estado: 'apagado' };

    // Un módulo que el catálogo declara encendido no debería producir 404.
    // Presentarlo como apagado ocultaría una falla de autorización o despliegue.
    return { estado: 'error' };
  } catch {
    return { estado: 'apagado-desconocido' };
  }
}

function opcionesDeLectura(signal?: AbortSignal): RequestInit {
  return {
    cache: 'no-store',
    credentials: 'include',
    headers: { accept: 'application/json' },
    ...(signal ? { signal } : {}),
  };
}

function normalizarResumen(
  valor: unknown,
): Extract<EstadoResumenCrash, { estado: 'listo' }> | null {
  if (
    !esRegistro(valor)
    || !enteroEnRango(valor.ventanaDias, 1, MAX_DIAS_RESUMEN)
    || !Array.isArray(valor.grupos)
    || valor.grupos.length > MAX_GRUPOS_RESUMEN
  ) {
    return null;
  }

  const grupos: GrupoCrashSeguro[] = [];
  for (const valorGrupo of valor.grupos) {
    if (!esRegistro(valorGrupo)) return null;

    const errorName = tipoDeErrorSeguro(valorGrupo.errorName);
    const appVersion = versionDeAppSegura(valorGrupo.appVersion);
    const deviceModel = modeloDeDispositivoSeguro(valorGrupo.deviceModel);
    const androidVersion = versionDeAndroidSegura(valorGrupo.androidVersion);
    const total = enteroNoNegativo(valorGrupo.total);
    const fatales = enteroNoNegativo(valorGrupo.fatales);

    if (
      !errorName
      || !appVersion
      || !deviceModel
      || !androidVersion
      || total === null
      || total === 0
      || fatales === null
      || fatales > total
    ) {
      return null;
    }

    grupos.push({
      errorName,
      appVersion,
      deviceModel,
      androidVersion,
      total,
      fatales,
    });
  }

  return { estado: 'listo', ventanaDias: valor.ventanaDias, grupos };
}

function tipoDeErrorSeguro(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const limpio = valor.trim();
  return limpio.length <= 120 && ERROR_NAMES_PERMITIDOS_SET.has(limpio)
    ? limpio
    : ERROR_NO_IDENTIFICADO;
}

function versionDeAppSegura(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  return valor.length <= 32 && PATRON_VERSION_APP.test(valor)
    ? valor
    : VERSION_APP_NO_IDENTIFICADA;
}

function modeloDeDispositivoSeguro(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const limpio = valor.trim();
  if (limpio.length < 2 || limpio.length > 64 || limpio.includes('  ')) {
    return MODELO_NO_IDENTIFICADO;
  }

  return DEVICE_MODELS_PERMITIDOS_SET.has(limpio)
    ? limpio
    : MODELO_NO_IDENTIFICADO;
}

function versionDeAndroidSegura(valor: unknown): string | null {
  if (typeof valor !== 'string') return null;
  const limpio = valor.trim();
  return limpio.length <= 8 && PATRON_VERSION_ANDROID.test(limpio)
    ? limpio
    : ANDROID_NO_IDENTIFICADO;
}

function esRegistro(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

function enteroEnRango(valor: unknown, minimo: number, maximo: number): valor is number {
  return typeof valor === 'number'
    && Number.isSafeInteger(valor)
    && valor >= minimo
    && valor <= maximo;
}

function enteroNoNegativo(valor: unknown): number | null {
  return enteroEnRango(valor, 0, Number.MAX_SAFE_INTEGER) ? valor : null;
}

export function CrashReportsSummary({ apiUrl }: { apiUrl: string }) {
  const [estado, setEstado] = useState<EstadoVistaResumenCrash>({ estado: 'cargando' });
  const intento = useRef(0);
  const controlador = useRef<AbortController | null>(null);

  const cargar = useCallback(() => {
    intento.current += 1;
    const actual = intento.current;
    controlador.current?.abort();
    const siguiente = new AbortController();
    controlador.current = siguiente;
    setEstado({ estado: 'cargando' });

    void cargarResumenCrashes(apiUrl, fetch, siguiente.signal).then((resultado) => {
      if (actual === intento.current && !siguiente.signal.aborted) setEstado(resultado);
    });
  }, [apiUrl]);

  useEffect(() => {
    cargar();
    return () => controlador.current?.abort();
  }, [cargar]);

  return <CrashReportsSummaryView estado={estado} onRetry={cargar} />;
}

/** Vista pura para probar estados y semántica sin simular el navegador. */
export function CrashReportsSummaryView({
  estado,
  onRetry,
}: {
  estado: EstadoVistaResumenCrash;
  onRetry: () => void;
}) {
  if (estado.estado === 'cargando') {
    return (
      <section
        aria-busy="true"
        aria-labelledby="crash-resumen-titulo"
        className="activity-card crash-summary"
      >
        <h2 id="crash-resumen-titulo">Fallas de la app</h2>
        <p role="status">Cargando el diagnóstico agregado…</p>
      </section>
    );
  }

  if (estado.estado === 'apagado') {
    return (
      <ResumenNoDisponible titulo="Módulo apagado">
        <span>El módulo no recopila ni envía reportes mientras está apagado.</span>
        <span>
          Abre <a href="?vista=reglas#funciones">Reglas de operación → Módulos contratados</a>,
          {' '}activa «Reporte de fallas de la app» y elige «Guardar módulos».
        </span>
      </ResumenNoDisponible>
    );
  }

  if (estado.estado === 'no-incluido') {
    return (
      <ResumenNoDisponible titulo="Módulo no incluido">
        <span>El plan de la empresa no incluye «Reporte de fallas de la app».</span>
        <span>Para habilitarlo, solicita un cambio de plan al proveedor de la plataforma.</span>
      </ResumenNoDisponible>
    );
  }

  if (estado.estado === 'apagado-desconocido') {
    return (
      <ResumenNoDisponible titulo="Diagnóstico no disponible">
        <span>No pudimos confirmar si el módulo está apagado o fuera del plan.</span>
        <span>
          Revisa <a href="?vista=reglas#funciones">Reglas de operación → Módulos contratados</a>.
          {' '}Si «Reporte de fallas de la app» no aparece, solicita el cambio de plan al proveedor.
        </span>
        <button className="secondary-button crash-retry" onClick={onRetry} type="button">
          Reintentar
        </button>
      </ResumenNoDisponible>
    );
  }

  if (estado.estado === 'error') {
    return (
      <section aria-labelledby="crash-resumen-titulo" className="activity-card crash-summary">
        <h2 id="crash-resumen-titulo">Fallas de la app</h2>
        <p className="form-message error" role="alert">
          No pudimos cargar el diagnóstico. No se muestran datos parciales.
        </p>
        <button className="secondary-button crash-retry" onClick={onRetry} type="button">
          Reintentar
        </button>
      </section>
    );
  }

  const total = estado.grupos.reduce(
    (suma, grupo) => sumaSaturada(suma, grupo.total),
    0,
  );
  const fatales = estado.grupos.reduce(
    (suma, grupo) => sumaSaturada(suma, grupo.fatales),
    0,
  );

  return (
    <section aria-labelledby="crash-resumen-titulo" className="activity-card crash-summary">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Salud técnica</span>
          <h2 id="crash-resumen-titulo">Fallas de la app</h2>
        </div>
        <span className="status-pill">Últimos {estado.ventanaDias} días</span>
      </div>
      <p className="section-explanation">
        Resumen por tipo técnico, versión y modelo. No muestra nombres de personas,
        identificadores, ubicación, mensajes de error ni trazas.
      </p>

      {estado.grupos.length === 0 ? (
        <div className="dashboard-empty">
          <strong>No hay fallas registradas</strong>
          <span>La consulta funcionó y no encontró reportes en esta ventana.</span>
        </div>
      ) : (
        <>
          <p className="crash-totals" aria-label={`${total} fallas, ${fatales} fatales`}>
            <strong>{total}</strong> fallas agregadas · <strong>{fatales}</strong> fatales
          </p>
          <div
            aria-label="Tabla desplazable de fallas de la app"
            className="crash-table-wrap"
            role="region"
            tabIndex={0}
          >
            <table className="crash-table">
              <caption>Fallas de la app por tipo, versión y modelo de dispositivo</caption>
              <thead>
                <tr>
                  <th scope="col">Tipo de falla</th>
                  <th scope="col">Versión de app</th>
                  <th scope="col">Modelo</th>
                  <th scope="col">Android</th>
                  <th className="numerica" scope="col">Fallas</th>
                  <th className="numerica" scope="col">Fatales</th>
                </tr>
              </thead>
              <tbody>
                {estado.grupos.map((grupo, index) => (
                  <tr
                    key={`${grupo.errorName}-${grupo.appVersion}-${grupo.deviceModel}-${grupo.androidVersion}-${index}`}
                  >
                    <th scope="row"><code>{grupo.errorName}</code></th>
                    <td>{grupo.appVersion}</td>
                    <td>{grupo.deviceModel}</td>
                    <td>{grupo.androidVersion}</td>
                    <td className="numerica">{grupo.total}</td>
                    <td className="numerica">{grupo.fatales}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

function sumaSaturada(a: number, b: number): number {
  return a > Number.MAX_SAFE_INTEGER - b ? Number.MAX_SAFE_INTEGER : a + b;
}

function ResumenNoDisponible({
  titulo,
  children,
}: {
  titulo: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby="crash-resumen-titulo" className="activity-card crash-summary">
      <h2 id="crash-resumen-titulo">Fallas de la app</h2>
      <div className="dashboard-empty">
        <strong>{titulo}</strong>
        {children}
      </div>
    </section>
  );
}
