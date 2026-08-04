'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { EstadoConexionPayload } from '../_lib/bridge/protocol';
import {
  descartarRechazadas,
  pedirApi,
  sincronizar,
  suscribirCola,
  suscribirVeredictos,
  type EstadoCola,
} from './guard-outbox';
import { borrarClave, escribirJson, leerJson } from './guard-storage';
import { useReglasSync, type ReglasSync } from './sync-reglas';

/**
 * Indicador de estado de sincronizacion del guardia (#74).
 *
 * Reemplaza a `GuardConnectionBar` y responde la unica pregunta que el guardia
 * se hace en terreno: ¿lo que acabo de hacer ya llego al servidor?
 *
 * Tres estados que no se mezclan, porque significan cosas distintas y se
 * resuelven distinto:
 *
 *   sincronizado — no queda nada en la cola.
 *   pendientes   — hay trabajo esperando. Sin señal esto es NORMAL, no una
 *                  falla: la ronda ocurre en subterraneos y perimetros.
 *   error        — el servidor rechazo algo, o hay señal y el envio igual
 *                  falla. Esto SI necesita que el guardia haga algo.
 *
 * Dos fuentes distintas, y ninguna reemplaza a la otra:
 *
 *   - La cola local (`guard-outbox`) dice que le falta subir a ESTE telefono.
 *   - `GET /sync/status` dice que tiene el SERVIDOR. Es la unica confirmacion
 *     real: que el telefono crea que mando no prueba que haya llegado.
 *
 * Cuando el servidor no contesta se dice tal cual ("no pudimos confirmar") en
 * vez de mostrar un visto bueno por defecto. Un indicador que miente en verde
 * es peor que no tener indicador.
 */

/** Piso de repintado de la interfaz. No es un plazo de negocio: es cada cuanto se refresca. */
const REFRESCO_MIN_MS = 10_000;

export type EstadoSync = 'sincronizado' | 'pendientes' | 'error';

export interface ResumenSync {
  estado: EstadoSync;
  /** Texto corto de la pildora. */
  titulo: string;
  /** Una linea que dice que esta pasando y que se espera del guardia. */
  detalle: string;
}

/** Lo que el servidor dice que tiene. `null` = no se pudo preguntar. */
export interface EstadoServidor {
  confirmadas: number;
  rechazadas: number;
  windowHours?: number;
  lastSyncedAt?: string;
}

function plural(cantidad: number, singular: string, varios: string): string {
  return cantidad === 1 ? singular : varios;
}

/**
 * Decide el estado y los textos. Funcion pura a proposito: es la regla de
 * lectura de la pantalla y se puede razonar sin React ni navegador.
 *
 * El orden de los casos importa. Un rechazo del servidor gana sobre todo lo
 * demas porque es lo unico que NO se arregla esperando; y "sin señal con cola"
 * se resuelve antes que "hubo un fallo de envio", porque el fallo viejo queda
 * pegado en la cola mientras el telefono esta sin cobertura, y pintarlo como
 * error convertiria la condicion normal de trabajo en una alarma permanente.
 */
export function resumirSync(entrada: {
  pendientes: number;
  rechazadas: number;
  sincronizando: boolean;
  fallo: boolean;
  enLinea: boolean;
}): ResumenSync {
  if (entrada.rechazadas > 0) {
    return {
      estado: 'error',
      titulo: `${entrada.rechazadas} ${plural(entrada.rechazadas, 'rechazado', 'rechazados')}`,
      detalle:
        'El servidor no aceptó parte de tu trabajo. Esto no se arregla esperando: ' +
        'revisa el detalle y avisa a tu supervisor.',
    };
  }

  if (entrada.pendientes === 0) {
    return {
      estado: 'sincronizado',
      titulo: 'Todo subido',
      detalle: 'No te queda nada por subir desde este teléfono.',
    };
  }

  if (entrada.sincronizando) {
    return {
      estado: 'pendientes',
      titulo: 'Subiendo…',
      detalle: `Estamos subiendo ${entrada.pendientes} ${plural(entrada.pendientes, 'registro', 'registros')} de tu ronda.`,
    };
  }

  if (!entrada.enLinea) {
    return {
      estado: 'pendientes',
      titulo: `${entrada.pendientes} sin subir`,
      detalle:
        'Sin señal. Tu trabajo quedó guardado en el teléfono y se sube solo apenas vuelva la conexión.',
    };
  }

  if (entrada.fallo) {
    return {
      estado: 'error',
      titulo: `${entrada.pendientes} sin subir`,
      detalle:
        'Hay señal, pero el envío está fallando. Toca «Sincronizar ahora»; si sigue igual ' +
        'después de un par de intentos, avisa a tu supervisor.',
    };
  }

  return {
    estado: 'pendientes',
    titulo: `${entrada.pendientes} sin subir`,
    detalle: 'Se están subiendo solos. No cierres la app todavía.',
  };
}

/**
 * Formateador de hora en la zona del RECINTO (`sites.timezone`), no la del
 * servidor ni la del navegador de quien mire.
 *
 * Una zona invalida hace que `Intl.DateTimeFormat` lance: se cae a la zona del
 * dispositivo en vez de dejar en blanco la pantalla del guardia. Aca solo se
 * formatea un instante, no se suma un dia, asi que no aplica la trampa del
 * cambio de horario.
 */
function crearFormatoHora(zonaHoraria?: string): Intl.DateTimeFormat {
  const opciones: Intl.DateTimeFormatOptions = {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };
  if (zonaHoraria !== undefined) {
    try {
      return new Intl.DateTimeFormat('es-CL', { ...opciones, timeZone: zonaHoraria });
    } catch {
      // Zona desconocida por este dispositivo: mejor la hora local que ninguna.
    }
  }
  return new Intl.DateTimeFormat('es-CL', opciones);
}

function formatearHora(formato: Intl.DateTimeFormat, iso: string | undefined): string | undefined {
  if (iso === undefined) return undefined;
  const fecha = new Date(iso);
  return Number.isNaN(fecha.getTime()) ? undefined : formato.format(fecha);
}

// --------------------------------------------------------- cuanto lleva atrasado

const CLAVE_ATRASO = 'voxia.guard.sync.atraso.v1';

interface AtrasoGuardado {
  pendientes: number;
  desdeMs: number;
}

/**
 * Instante en que empezo el atraso actual, o `null` si no hay nada pendiente.
 *
 * La cola solo publica CUANTAS operaciones esperan, no desde cuando; el reloj
 * se lleva aca y se persiste para que cerrar y reabrir el WebView a mitad de
 * ronda no lo reinicie, que es justo el caso donde el atraso importa. Cada vez
 * que baja la cantidad pendiente hubo progreso y el reloj vuelve a cero: lo
 * que se mide es "cuanto llevo sin poder subir nada", no la edad del mas viejo.
 */
function useDesdeSinSubir(pendientes: number): number | null {
  const [desde, setDesde] = useState<number | null>(null);
  const anterior = useRef<number | null>(null);
  const iniciado = useRef(false);

  useEffect(() => {
    const ahora = Date.now();
    const previos = anterior.current;
    anterior.current = pendientes;

    if (pendientes === 0) {
      // En el primer render la cola todavia no se leyo (llega en 0 y sube al
      // suscribirse): borrar aqui tiraria el instante guardado antes de leerlo.
      if (iniciado.current) borrarClave(CLAVE_ATRASO);
      if (desde !== null) setDesde(null);
      return;
    }

    if (!iniciado.current) {
      iniciado.current = true;
      const guardado = leerJson<AtrasoGuardado | null>(CLAVE_ATRASO, null);
      const rescatable =
        guardado !== null &&
        typeof guardado.desdeMs === 'number' &&
        Number.isFinite(guardado.desdeMs) &&
        guardado.desdeMs <= ahora;
      const inicio = rescatable ? guardado.desdeMs : ahora;
      setDesde(inicio);
      escribirJson(CLAVE_ATRASO, { pendientes, desdeMs: inicio });
      return;
    }

    if (desde === null || (previos !== null && pendientes < previos)) {
      setDesde(ahora);
      escribirJson(CLAVE_ATRASO, { pendientes, desdeMs: ahora });
    }
  }, [desde, pendientes]);

  return desde;
}

// ------------------------------------------------------------ estado del servidor

async function leerEstadoServidor(apiUrl: string): Promise<EstadoServidor | null> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return null;
  try {
    const respuesta = await pedirApi(apiUrl, '/sync/status');
    if (!respuesta.ok) return null;
    const cuerpo = (await respuesta.json()) as {
      windowHours?: number;
      operations?: { applied?: number; duplicated?: number; rejected?: number };
      lastSyncedAt?: string | null;
    };
    // 'aplicado' y 'duplicado' son el mismo desenlace para el guardia: el
    // trabajo esta en el servidor. La distincion es de observabilidad.
    const aplicadas = cuerpo.operations?.applied ?? 0;
    const duplicadas = cuerpo.operations?.duplicated ?? 0;
    return {
      confirmadas: aplicadas + duplicadas,
      rechazadas: cuerpo.operations?.rejected ?? 0,
      ...(typeof cuerpo.windowHours === 'number' ? { windowHours: cuerpo.windowHours } : {}),
      ...(typeof cuerpo.lastSyncedAt === 'string' ? { lastSyncedAt: cuerpo.lastSyncedAt } : {}),
    };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- componente

const COLA_VACIA: EstadoCola = { pendientes: 0, rechazadas: [], sincronizando: false };

export interface SyncEstadoProps {
  apiUrl: string;
  /**
   * Conectividad segun el puente nativo. Si no viene, se escucha al navegador:
   * la misma pantalla se abre en el escritorio del supervisor, donde no hay
   * shell nativo que la reporte.
   */
  conexion?: EstadoConexionPayload;
  /** `sites.timezone` del recinto de la ronda. Sin esto se usa la del dispositivo. */
  zonaHoraria?: string;
  /** Recinto de la ronda, para resolver las reglas al nivel correcto de la cascada. */
  siteId?: string;
  /** Reglas ya resueltas por el padre. Si no vienen, las pide este componente. */
  reglas?: ReglasSync;
  /** Avisa al navegador antes de cerrar la pestaña con trabajo sin subir. */
  avisarAlSalir?: boolean;
}

export function SyncEstado({
  apiUrl,
  conexion,
  zonaHoraria,
  siteId,
  reglas,
  avisarAlSalir = true,
}: SyncEstadoProps) {
  const [cola, setCola] = useState<EstadoCola>(COLA_VACIA);
  const [servidor, setServidor] = useState<EstadoServidor | null>(null);
  const [consultado, setConsultado] = useState(false);
  const [mensaje, setMensaje] = useState<string>();
  const [enviando, setEnviando] = useState(false);
  // Valor fijo en el primer render: leer `navigator` aca romperia la hidratacion.
  const [enLineaNavegador, setEnLineaNavegador] = useState(true);
  const [ahora, setAhora] = useState(() => Date.now());

  const reglasApi = useReglasSync(apiUrl, siteId, reglas === undefined);
  const reglasActivas = reglas ?? reglasApi;
  const enLinea = conexion?.enLinea ?? enLineaNavegador;

  useEffect(() => suscribirCola(setCola), []);

  // Sin puente nativo manda el navegador. Con puente, la prop `conexion` ya
  // trae el dato y esto queda como respaldo inofensivo.
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const leer = () => setEnLineaNavegador(navigator.onLine);
    leer();
    window.addEventListener('online', leer);
    window.addEventListener('offline', leer);
    return () => {
      window.removeEventListener('online', leer);
      window.removeEventListener('offline', leer);
    };
  }, []);

  const consultarServidor = useCallback(async () => {
    const estado = await leerEstadoServidor(apiUrl);
    setServidor(estado);
    setConsultado(true);
  }, [apiUrl]);

  /**
   * Cuando se le pregunta al servidor: al montar, al volver la señal, al
   * volver la pantalla al frente y despues de cada lote sincronizado. Sin
   * temporizador propio: un WebView en segundo plano no ejecuta timers, y
   * consultar por consultar gasta bateria de un turno de ocho horas.
   */
  useEffect(() => {
    let cancelado = false;
    const consultar = () => {
      if (!cancelado) void consultarServidor();
    };
    const alVolverAlFrente = () => {
      if (document.visibilityState === 'visible') consultar();
    };

    consultar();
    const baja = suscribirVeredictos(consultar);
    window.addEventListener('online', consultar);
    document.addEventListener('visibilitychange', alVolverAlFrente);
    return () => {
      cancelado = true;
      baja();
      window.removeEventListener('online', consultar);
      document.removeEventListener('visibilitychange', alVolverAlFrente);
    };
  }, [consultarServidor]);

  const desde = useDesdeSinSubir(cola.pendientes);

  // El repintado solo existe mientras hay atraso que contar. El periodo se
  // deriva del umbral configurado para que el aviso no aparezca tarde; el piso
  // de 10 s es granularidad de interfaz, no un plazo de negocio.
  useEffect(() => {
    if (desde === null || typeof window === 'undefined') return undefined;
    const periodo = Math.max(REFRESCO_MIN_MS, (reglasActivas.esperaMaxMin * 60_000) / 10);
    const marcar = () => setAhora(Date.now());
    const id = window.setInterval(marcar, periodo);
    document.addEventListener('visibilitychange', marcar);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', marcar);
    };
  }, [desde, reglasActivas.esperaMaxMin]);

  const sinSubir = cola.pendientes + cola.rechazadas.length;

  // Ultima red de seguridad del navegador de escritorio. En el WebView, cerrar
  // la app no dispara este evento; por eso el aviso de cierre de turno
  // (`SyncAvisoCierre`) es el mecanismo principal y esto solo un extra.
  useEffect(() => {
    if (!avisarAlSalir || sinSubir === 0 || typeof window === 'undefined') return undefined;
    const alCerrar = (evento: BeforeUnloadEvent) => {
      evento.preventDefault();
      evento.returnValue = '';
    };
    window.addEventListener('beforeunload', alCerrar);
    return () => window.removeEventListener('beforeunload', alCerrar);
  }, [avisarAlSalir, sinSubir]);

  const formato = useMemo(() => crearFormatoHora(zonaHoraria), [zonaHoraria]);

  const resumen = resumirSync({
    pendientes: cola.pendientes,
    rechazadas: cola.rechazadas.length,
    sincronizando: cola.sincronizando,
    fallo: cola.ultimoFallo !== undefined,
    enLinea,
  });

  const minutosSinSubir = desde === null ? 0 : Math.floor((ahora - desde) / 60_000);
  const demorado = cola.pendientes > 0 && minutosSinSubir >= reglasActivas.esperaMaxMin;
  const horaUltimoEnvio = formatearHora(formato, cola.ultimoEnvioAt);
  const horaConfirmacion = formatearHora(formato, servidor?.lastSyncedAt);

  async function sincronizarAhora() {
    setMensaje(undefined);
    if (!enLinea) {
      setMensaje('Sin señal: todavía no se puede subir. Se sube solo apenas vuelva la conexión.');
      return;
    }
    setEnviando(true);
    const habia = cola.pendientes;
    try {
      await sincronizar(apiUrl);
      await consultarServidor();
      if (habia === 0) setMensaje('No había nada pendiente: ya estaba todo en el servidor.');
    } finally {
      setEnviando(false);
    }
  }

  const ocupado = enviando || cola.sincronizando;

  return (
    <div className="guardia-conexion">
      <p className="guardia-conexion-linea" role="status" aria-live="polite">
        <span className={`guardia-senal ${enLinea ? 'ok' : 'sin'}`} aria-hidden="true" />
        <strong>{enLinea ? 'Con señal' : 'Sin señal'}</strong>
        <span className={clasePildora(resumen.estado)}>{resumen.titulo}</span>
        {horaUltimoEnvio ? <small>Último envío {horaUltimoEnvio}</small> : null}
      </p>

      <p className="guardia-conexion-linea">
        <small>{resumen.detalle}</small>
      </p>

      <p className="guardia-conexion-linea">
        <small>
          {confirmacionDelServidor({ enLinea, consultado, servidor, horaConfirmacion })}
        </small>
      </p>

      <button
        className="guardia-boton-secundario"
        type="button"
        onClick={() => void sincronizarAhora()}
        disabled={ocupado}
      >
        {ocupado ? 'Subiendo…' : 'Sincronizar ahora'}
      </button>

      {mensaje ? (
        <p className="guardia-conexion-linea" role="status" aria-live="polite">
          <small>{mensaje}</small>
        </p>
      ) : null}

      {demorado ? (
        <p className="guardia-aviso" role="status">
          Llevas {minutosSinSubir} {plural(minutosSinSubir, 'minuto', 'minutos')} sin poder subir tu
          ronda. Busca un lugar con señal —la entrada del recinto o el patio— antes de terminar el
          turno.
        </p>
      ) : null}

      {cola.rechazadas.length ? (
        <div className="guardia-rechazos" role="alert">
          <strong>
            {cola.rechazadas.length === 1
              ? 'Una operación no se pudo registrar'
              : `${cola.rechazadas.length} operaciones no se pudieron registrar`}
          </strong>
          <ul>
            {cola.rechazadas.map((operacion) => (
              <li key={operacion.clientId}>
                {operacion.type === 'scan' ? 'Escaneo' : 'Novedad'}:{' '}
                {operacion.motivo ?? 'El servidor la rechazó.'}
              </li>
            ))}
          </ul>
          <button className="guardia-boton-secundario" type="button" onClick={descartarRechazadas}>
            Entendido
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * La pildora de error pide una clase nueva (`.guardia-cola.error`, ver
 * INTEGRACION.md). Se mantiene `alerta` para que, si esa clase todavia no esta
 * en globals.css, el estado siga destacado en ambar en vez de verse "todo bien".
 */
function clasePildora(estado: EstadoSync): string {
  if (estado === 'error') return 'guardia-cola alerta error';
  return estado === 'pendientes' ? 'guardia-cola alerta' : 'guardia-cola';
}

/**
 * Lo que dice el SERVIDOR, que es distinto de lo que cree el telefono. Cuando
 * no se pudo preguntar, se dice; no se asume.
 */
function confirmacionDelServidor(entrada: {
  enLinea: boolean;
  consultado: boolean;
  servidor: EstadoServidor | null;
  horaConfirmacion: string | undefined;
}): string {
  if (!entrada.enLinea) return 'Sin señal: no se puede confirmar con el servidor.';
  if (!entrada.consultado) return 'Confirmando con el servidor…';
  if (entrada.servidor === null) return 'No pudimos confirmar con el servidor.';

  const ventana =
    entrada.servidor.windowHours === undefined
      ? ''
      : ` Tiene ${entrada.servidor.confirmadas} ${plural(entrada.servidor.confirmadas, 'registro', 'registros')} tuyos de las últimas ${entrada.servidor.windowHours} horas.`;

  return entrada.horaConfirmacion === undefined
    ? `El servidor todavía no tiene registros tuyos.${ventana}`
    : `El servidor confirmó tu último envío a las ${entrada.horaConfirmacion}.${ventana}`;
}
