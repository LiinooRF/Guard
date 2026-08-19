import { PROTOCOLO_MAJOR } from '../bridge/protocol';
import mobilePackage from '../../package.json';
import { recortar, sanitizarTexto } from './scrubber';

export interface ReportCrashPayload {
  errorName: string;
  errorMessage: string;
  stack?: string;
  appVersion: string;
  deviceModel: string;
  androidVersion: string;
  bridgeProtocolVersion?: number;
  fatal?: boolean;
  occurredAt?: string;
}

export interface StorageAdapter {
  getItemAsync: (key: string) => Promise<string | null>;
  setItemAsync: (key: string, value: string) => Promise<void>;
  deleteItemAsync: (key: string) => Promise<void>;
}

const STORAGE_CLEAN_EXIT = 'sentrycore.clean_exit.v1';
const STORAGE_CRASH_QUEUE = 'sentrycore.crash_queue.v1';
const MAX_QUEUE_SIZE = 20;

let PlatformActual: {
  OS: string;
  Version?: number | string;
  constants?: { Model?: string; Brand?: string; Manufacturer?: string };
} = {
  OS: 'android',
  Version: '13',
  constants: { Model: 'Android Device', Brand: 'Generic' },
};

let AppStateActual: {
  addEventListener: (type: string, listener: (state: string) => void) => { remove?: () => void } | void;
} = {
  addEventListener: () => {},
};

let SecureStoreActual: StorageAdapter = {
  getItemAsync: async () => null,
  setItemAsync: async () => {},
  deleteItemAsync: async () => {},
};

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rn = require('react-native');
  if (rn?.Platform) PlatformActual = rn.Platform;
  if (rn?.AppState) AppStateActual = rn.AppState;
} catch {
  // Fallback seguro si react-native no está presente en el entorno
}

try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ss = require('expo-secure-store');
  if (ss?.getItemAsync) SecureStoreActual = ss;
} catch {
  // Fallback seguro
}

let storageActivo: StorageAdapter = SecureStoreActual;

export function setStorageAdapter(adapter: StorageAdapter): void {
  storageActivo = adapter;
}

export function setPlatformMock(mock: typeof PlatformActual): void {
  PlatformActual = mock;
}

let apiUrlActual: string | null = null;
let enviandoCaida = false;

export function configurarApiUrl(url: string | null): void {
  if (url) {
    apiUrlActual = url.replace(/\/$/, '');
  }
}

export function obtenerDeviceModel(): string {
  if (PlatformActual.OS === 'android') {
    const c = PlatformActual.constants as { Model?: string; Brand?: string; Manufacturer?: string };
    const modelo = (c?.Model || c?.Brand || 'Android Device').trim();
    return recortar(modelo, 64);
  }
  return recortar(PlatformActual.OS || 'Unknown Device', 64);
}

export function obtenerAndroidVersion(): string {
  if (PlatformActual.OS === 'android') {
    const v = PlatformActual.Version ? String(PlatformActual.Version).trim() : 'Android';
    return recortar(v, 32);
  }
  return 'Unknown';
}

export function formatearErrorParaReporte(
  error: unknown,
  opciones: { fatal?: boolean; stackManual?: string } = {},
): ReportCrashPayload {
  let errorName = 'Error';
  let errorMessage = 'Error desconocido';
  let stack: string | undefined = opciones.stackManual;

  if (error instanceof Error) {
    errorName = error.name || 'Error';
    errorMessage = error.message || 'Error desconocido';
    if (!stack && error.stack) {
      stack = error.stack;
    }
  } else if (typeof error === 'string') {
    errorMessage = error;
  } else if (error && typeof error === 'object') {
    errorMessage = JSON.stringify(error);
  }

  const sanitizedName = recortar(sanitizarTexto(errorName) || 'Error', 120);
  const sanitizedMessage = recortar(sanitizarTexto(errorMessage) || 'Error sin descripción', 4_000);
  const sanitizedStack = stack ? recortar(sanitizarTexto(stack), 40_000) : undefined;

  return {
    errorName: sanitizedName,
    errorMessage: sanitizedMessage,
    ...(sanitizedStack ? { stack: sanitizedStack } : {}),
    appVersion: recortar(mobilePackage.version || '0.1.0', 32),
    deviceModel: obtenerDeviceModel(),
    androidVersion: obtenerAndroidVersion(),
    bridgeProtocolVersion: PROTOCOLO_MAJOR,
    fatal: opciones.fatal ?? false,
    occurredAt: new Date().toISOString(),
  };
}

export async function encolarCaidaOffline(payload: ReportCrashPayload): Promise<void> {
  try {
    const guardadasStr = await storageActivo.getItemAsync(STORAGE_CRASH_QUEUE);
    const lista: ReportCrashPayload[] = guardadasStr ? JSON.parse(guardadasStr) : [];
    if (lista.length >= MAX_QUEUE_SIZE) {
      lista.shift(); // Descartar la más antigua para mantener límite
    }
    lista.push(payload);
    await storageActivo.setItemAsync(STORAGE_CRASH_QUEUE, JSON.stringify(lista));
  } catch {
    // Si falla el almacenamiento seguro, no interrumpimos la app
  }
}

export async function vaciarColaDeCaidas(apiUrl?: string): Promise<void> {
  const url = apiUrl || apiUrlActual;
  if (!url || enviandoCaida) return;

  try {
    const guardadasStr = await storageActivo.getItemAsync(STORAGE_CRASH_QUEUE);
    if (!guardadasStr) return;

    const lista: ReportCrashPayload[] = JSON.parse(guardadasStr);
    if (!Array.isArray(lista) || lista.length === 0) return;

    enviandoCaida = true;
    const noEnviadas: ReportCrashPayload[] = [];

    for (const caida of lista) {
      try {
        const respuesta = await fetch(`${url}/crash-reports`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(caida),
        });
        if (!respuesta.ok && respuesta.status >= 500) {
          noEnviadas.push(caida);
        }
      } catch {
        noEnviadas.push(caida);
      }
    }

    if (noEnviadas.length > 0) {
      await storageActivo.setItemAsync(STORAGE_CRASH_QUEUE, JSON.stringify(noEnviadas));
    } else {
      await storageActivo.deleteItemAsync(STORAGE_CRASH_QUEUE);
    }
  } catch {
    // Silencioso
  } finally {
    enviandoCaida = false;
  }
}

export async function reportarCaida(
  error: unknown,
  opciones: { fatal?: boolean; stackManual?: string; apiUrl?: string } = {},
): Promise<void> {
  // Protección contra bucles infinitos: si el reportero causa un error, no volvemos a entrar
  if (enviandoCaida) return;

  const payload = formatearErrorParaReporte(error, opciones);
  const url = opciones.apiUrl || apiUrlActual;

  if (!url) {
    await encolarCaidaOffline(payload);
    return;
  }

  enviandoCaida = true;
  try {
    const controlador = new AbortController();
    const temporizador = setTimeout(() => controlador.abort(), 5_000);

    const respuesta = await fetch(`${url}/crash-reports`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(payload),
      signal: controlador.signal,
    }).finally(() => clearTimeout(temporizador));

    if (!respuesta.ok && respuesta.status >= 500) {
      await encolarCaidaOffline(payload);
    }
  } catch {
    // Si no hay red o timeout, guardamos para reintento posterior
    await encolarCaidaOffline(payload);
  } finally {
    enviandoCaida = false;
  }
}

export async function registrarArranqueYVerificarCierre(apiUrl?: string): Promise<void> {
  try {
    const ultimoEstado = await storageActivo.getItemAsync(STORAGE_CLEAN_EXIT);
    if (ultimoEstado === 'false') {
      // La ejecución anterior terminó bruscamente sin pasar por background ni cerrar limpiamente
      const reporteNativo: ReportCrashPayload = {
        errorName: 'NativeCrash',
        errorMessage: 'La aplicación terminó de forma inesperada en la ejecución anterior',
        appVersion: recortar(mobilePackage.version || '0.1.0', 32),
        deviceModel: obtenerDeviceModel(),
        androidVersion: obtenerAndroidVersion(),
        bridgeProtocolVersion: PROTOCOLO_MAJOR,
        fatal: true,
        occurredAt: new Date().toISOString(),
      };
      await reportarCaida(reporteNativo, { fatal: true, apiUrl });
    }

    // Marcamos que la sesión actual está en ejecución
    await storageActivo.setItemAsync(STORAGE_CLEAN_EXIT, 'false');

    // Escuchador de AppState: cuando la app pasa a background, marcamos como salida limpia
    AppStateActual.addEventListener('change', (proximoEstado: string) => {
      if (proximoEstado === 'background' || proximoEstado === 'inactive') {
        void storageActivo.setItemAsync(STORAGE_CLEAN_EXIT, 'true');
      } else if (proximoEstado === 'active') {
        void storageActivo.setItemAsync(STORAGE_CLEAN_EXIT, 'false');
      }
    });

    // Intentamos vaciar cualquier reporte de caídas pendiente en cola
    void vaciarColaDeCaidas(apiUrl);
  } catch {
    // Silencioso
  }
}

export function instalarReportadorGlobal(obtenerApi: () => string | null): void {
  const globalAny = global as unknown as {
    ErrorUtils?: {
      getGlobalHandler?: () => (error: Error, isFatal?: boolean) => void;
      setGlobalHandler?: (handler: (error: Error, isFatal?: boolean) => void) => void;
    };
  };

  if (!globalAny.ErrorUtils?.setGlobalHandler) return;

  const handlerPrevio = globalAny.ErrorUtils.getGlobalHandler?.();

  globalAny.ErrorUtils.setGlobalHandler((error: Error, isFatal?: boolean) => {
    const url = obtenerApi();

    if (isFatal) {
      // Un fatal termina el proceso apenas vuelve este handler (es lo que hace
      // el handlerPrevio de React Native): un `fetch` async no alcanza a
      // completarse, y el `catch` de reportarCaida() que encolaria offline
      // tampoco corre. Por eso primero se ENCOLA -una escritura en storage que
      // el proceso si alcanza a esperar- y recien despues se cede el proceso.
      // El intento de envio inmediato (vaciarColaDeCaidas) es beneficio extra,
      // no la garantia: si el proceso muere antes de que termine, la cola la
      // manda en el proximo arranque (registrarArranqueYVerificarCierre).
      const payload = formatearErrorParaReporte(error, { fatal: true });
      encolarCaidaOffline(payload)
        .then(() => vaciarColaDeCaidas(url ?? undefined))
        .catch(() => undefined)
        .finally(() => {
          if (handlerPrevio) handlerPrevio(error, isFatal);
        });
      return;
    }

    void reportarCaida(error, { fatal: isFatal ?? false, apiUrl: url ?? undefined });

    if (handlerPrevio) {
      handlerPrevio(error, isFatal);
    }
  });
}
