import type { NextFunction, Request, Response } from 'express';

import { csrfOriginProtection } from './csrf-origin.middleware';

function invoke(input: Partial<Request>) {
  const next = jest.fn();
  csrfOriginProtection('https://control.example.com')(
    { method: 'POST', headers: {}, ...input } as Request,
    {} as Response,
    next as NextFunction,
  );
  return next;
}

describe('csrfOriginProtection', () => {
  it('acepta mutaciones desde el origen web configurado', () => {
    expect(
      invoke({ headers: { origin: 'https://control.example.com' } }),
    ).toHaveBeenCalledWith();
  });

  it('rechaza una mutación web desde otro origen', () => {
    const next = invoke({ headers: { origin: 'https://attacker.example' } });
    expect(next.mock.calls[0]?.[0]).toMatchObject({ status: 403 });
  });

  it('acepta al cliente nativo sin cookies ambientales', () => {
    expect(
      invoke({ headers: { 'x-sentrycore-client': 'mobile' } }),
    ).toHaveBeenCalledWith();
  });

  it('no permite usar la excepción móvil cuando existen cookies', () => {
    const next = invoke({
      headers: { 'x-sentrycore-client': 'mobile', cookie: 'sentrycore_access=token' },
    });
    expect(next.mock.calls[0]?.[0]).toMatchObject({ status: 403 });
  });
});
