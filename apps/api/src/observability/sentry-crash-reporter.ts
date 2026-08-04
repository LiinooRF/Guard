import { Logger } from '@nestjs/common';

import type { CrashEvent, CrashReporter } from './crash-event';
import type { CrashReportingConfig, SentryDsn } from './crash-reporting.config';
import { cabecerasEnvelope, construirEnvelope } from './sentry-envelope';

/**
 * Transporte hacia Sentry (#27).
 *
 * REGLA UNICA DE ESTE ARCHIVO: nunca lanzar, nunca demorar de mas. Un proveedor
 * de terceros caido no puede transformarse en una API caida. La ronda del
 * guardia no se detiene porque Sentry este en mantencion.
 */

/** Lo minimo que este modulo necesita de una respuesta HTTP. */
export interface RespuestaEnvio {
  readonly status: number;
}

/**
 * El envio, inyectable. Existe para poder probar el transporte sin red — y sin
 * mockear `fetch` global, que deja el mock puesto para el resto de la suite.
 */
export type EnvioHttp = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  },
) => Promise<RespuestaEnvio>;

const envioPorDefecto: EnvioHttp = (url, init) => fetch(url, init);

/**
 * Cortacircuito. Tras esta cantidad de fallos seguidos se deja de intentar
 * durante PAUSA_MS.
 *
 * NO VA A rules.ts y es a proposito: no es una regla de negocio. Ningun cliente
 * de vigilancia configura la tolerancia a fallos de nuestro proveedor de
 * errores, y exponerlo en el panel del ADMIN seria ofrecerle una perilla que no
 * significa nada para el. rules.ts es para lo que decide la operacion de la
 * empresa (umbrales, fotos, horarios), no para constantes de infraestructura.
 */
const FALLOS_PARA_ABRIR = 5;
const PAUSA_MS = 5 * 60 * 1_000;

/** Tope del cuerpo. Sentry rechaza sobre 1 MB; cortamos mucho antes. */
const MAX_CUERPO_BYTES = 200 * 1_024;

/** Driver 'off': no manda nada y no pretende lo contrario. */
export class NoopCrashReporter implements CrashReporter {
  readonly enabled = false;

  async send(): Promise<boolean> {
    return false;
  }
}

export class SentryCrashReporter implements CrashReporter {
  readonly enabled = true;

  private readonly logger = new Logger(SentryCrashReporter.name);
  private fallosSeguidos = 0;
  private pausadoHasta = 0;

  constructor(
    private readonly dsn: SentryDsn,
    private readonly timeoutMs: number,
    private readonly envio: EnvioHttp = envioPorDefecto,
    private readonly ahora: () => number = Date.now,
  ) {}

  async send(evento: CrashEvent): Promise<boolean> {
    if (this.ahora() < this.pausadoHasta) return false;

    let cuerpo: string;
    try {
      cuerpo = construirEnvelope(evento);
    } catch {
      // Armar el sobre no deberia fallar nunca; si falla, se pierde el evento y
      // no se arrastra al llamador.
      this.registrarFallo('sobre_invalido');
      return false;
    }

    if (Buffer.byteLength(cuerpo, 'utf8') > MAX_CUERPO_BYTES) {
      this.registrarFallo('cuerpo_demasiado_grande');
      return false;
    }

    try {
      const respuesta = await this.envio(this.dsn.envelopeUrl, {
        method: 'POST',
        headers: cabecerasEnvelope(this.dsn),
        body: cuerpo,
        signal: this.senalDeTiempo(),
      });

      // 429 y 5xx: el proveedor pide que paremos. Cuenta como fallo para que el
      // cortacircuito se abra en vez de seguir golpeando.
      if (respuesta.status >= 200 && respuesta.status < 300) {
        this.fallosSeguidos = 0;
        return true;
      }

      this.registrarFallo('respuesta_no_ok', respuesta.status);
      return false;
    } catch {
      // Sin el objeto de error en el log: un error de red de undici trae la URL
      // completa, y la URL lleva la clave publica del proyecto.
      this.registrarFallo('sin_respuesta');
      return false;
    }
  }

  private senalDeTiempo(): AbortSignal | undefined {
    if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') {
      return undefined;
    }
    return AbortSignal.timeout(this.timeoutMs);
  }

  /**
   * El log lleva el motivo y el estado, nunca el evento ni el DSN. Si el evento
   * fuera al log, un dato que no quisimos mandar a un tercero terminaria igual
   * en el archivo de logs, que es adonde miran mas personas.
   */
  private registrarFallo(motivo: string, estado?: number): void {
    this.fallosSeguidos += 1;

    if (this.fallosSeguidos >= FALLOS_PARA_ABRIR && this.pausadoHasta <= this.ahora()) {
      this.pausadoHasta = this.ahora() + PAUSA_MS;
    }

    this.logger.warn(
      JSON.stringify({
        event: 'crash_report_envio_fallido',
        motivo,
        ...(estado === undefined ? {} : { estado }),
        fallos_seguidos: this.fallosSeguidos,
        pausado: this.pausadoHasta > this.ahora(),
      }),
    );
  }
}

/** Elige el transporte segun la configuracion. Es el unico lugar que decide. */
export function crearCrashReporter(
  config: CrashReportingConfig,
  envio?: EnvioHttp,
): CrashReporter {
  if (config.driver !== 'sentry' || !config.dsn) return new NoopCrashReporter();
  return new SentryCrashReporter(config.dsn, config.timeoutMs, envio);
}
