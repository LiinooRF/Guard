import type { NextFunction, Request, Response } from 'express';

import { loggedPath, requestLogging } from './request-logging.middleware';

describe('loggedPath', () => {
  it('reemplaza el token de traspaso por un marcador', () => {
    const token = 'a'.repeat(43);
    expect(loggedPath(`/api/auth/handoff/${token}`)).toBe('/api/auth/handoff/:token');
    expect(loggedPath(`/auth/handoff/${token}`)).toBe('/auth/handoff/:token');
  });

  it('no toca las rutas normales, ni la de emisión que no lleva token', () => {
    expect(loggedPath('/api/auth/handoff')).toBe('/api/auth/handoff');
    expect(loggedPath('/api/auth/sessions/1234')).toBe('/api/auth/sessions/1234');
    expect(loggedPath('/api/guard/home')).toBe('/api/guard/home');
  });
});

describe('requestLogging', () => {
  it('no escribe el token de traspaso en el log de accesos', () => {
    const token = 'b'.repeat(43);
    const write = jest.spyOn(process.stdout, 'write').mockReturnValue(true);

    let finish = (): void => undefined;
    const response = {
      statusCode: 303,
      setHeader: jest.fn(),
      once: (_event: string, callback: () => void) => {
        finish = callback;
      },
    } as unknown as Response;
    const request = {
      method: 'GET',
      path: `/api/auth/handoff/${token}`,
      header: () => undefined,
    } as unknown as Request;
    const next: NextFunction = jest.fn();

    requestLogging(request, response, next);
    finish();
    const linea = String(write.mock.calls[0]?.[0] ?? '');
    write.mockRestore();

    expect(linea).toContain('/api/auth/handoff/:token');
    expect(linea).not.toContain(token);
  });
});
