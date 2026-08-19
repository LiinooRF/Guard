import type { LoggerService } from '@nestjs/common';

import { requestLogContext } from './request-context';

type Level = 'error' | 'warn' | 'log' | 'debug' | 'verbose' | 'fatal';

/**
 * Un solo objeto JSON por línea. Deliberadamente no serializa objetos arbitrarios:
 * podrían contener credenciales, tokens o datos personales.
 */
export class StructuredLogger implements LoggerService {
  log(message: unknown, context?: string): void {
    this.write('log', message, context);
  }

  error(message: unknown, _trace?: string, context?: string): void {
    this.write('error', message, context);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('verbose', message, context);
  }

  fatal(message: unknown, _trace?: string, context?: string): void {
    this.write('fatal', message, context);
  }

  private write(level: Level, message: unknown, context?: string): void {
    const request = requestLogContext.current();
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      context: context ?? null,
      request_id: request.requestId,
      tenant_id: request.tenantId,
      message: this.safeMessage(message),
    });

    (level === 'error' || level === 'fatal' ? process.stderr : process.stdout).write(`${line}\n`);
  }

  private safeMessage(message: unknown): string {
    if (typeof message === 'string') {
      // Los eventos propios ya vienen como JSON sin PII; los demás se limitan
      // para evitar que errores de librerías impriman secretos completos.
      return message.slice(0, 2_000);
    }
    if (message instanceof Error) return this.resumenDeError(message);
    return 'structured_event';
  }

  /**
   * De un error salen su nombre y los IDENTIFICADORES que lo ubican, nunca
   * valores.
   *
   * Antes salia solo `message.name`, y eso dejo ciego un incidente real: el
   * panel devolvia 500 al asignar una tarjeta NFC y el log entero decia
   * `QueryFailedError`, sin una pista de que era un `42P08` (parametro sin
   * tipo). Diagnosticarlo llevo horas de reproducir a mano lo que el SQLSTATE
   * decia en cinco caracteres.
   *
   * El mensaje completo de PostgreSQL sigue SIN registrarse a proposito: en un
   * `23505` incluye la fila que choco —correo, nombre, RUT—, y eso es dato de
   * persona en un log. El codigo, la restriccion, la tabla y la columna son
   * nombres del esquema: identifican el problema sin contar el contenido.
   */
  private resumenDeError(error: Error): string {
    const causa = error as Error & {
      code?: unknown;
      constraint?: unknown;
      table?: unknown;
      column?: unknown;
      driverError?: { code?: unknown; constraint?: unknown; table?: unknown; column?: unknown };
    };
    const origen = causa.driverError ?? causa;
    const partes = [error.name];
    for (const [clave, valor] of [
      ['code', origen.code ?? causa.code],
      ['constraint', origen.constraint ?? causa.constraint],
      ['table', origen.table ?? causa.table],
      ['column', origen.column ?? causa.column],
    ] as const) {
      if (typeof valor === 'string' && valor) partes.push(`${clave}=${valor.slice(0, 120)}`);
    }
    return partes.join(' ');
  }
}
