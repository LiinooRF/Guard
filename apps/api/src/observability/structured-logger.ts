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
    if (message instanceof Error) return message.name;
    return 'structured_event';
  }
}
