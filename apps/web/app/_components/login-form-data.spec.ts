import { leerCredenciales } from './login-form-data';

function formulario(valores: Record<string, string>): Pick<FormData, 'get'> {
  return { get: (campo) => valores[String(campo)] ?? null };
}

describe('datos reales del formulario de acceso', () => {
  it('usa los valores visibles aunque el estado de React no haya recibido onChange', () => {
    expect(
      leerCredenciales(
        formulario({
          identity: '  admin@demo-andina.test  ',
          password: 'form-password',
        }),
      ),
    ).toEqual({
      identity: 'admin@demo-andina.test',
      password: 'form-password',
      tenantId: '',
    });
  });

  it('mantiene vacíos los campos que no existen', () => {
    expect(leerCredenciales(formulario({}))).toEqual({
      identity: '',
      password: '',
      tenantId: '',
    });
  });
});

