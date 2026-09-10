import { rutaDelPanel } from './login-navegacion';

describe('rutaDelPanel', () => {
  it('lleva a cada rol a su panel, en minusculas', () => {
    expect(rutaDelPanel('SUPERVISOR')).toBe('/app/supervisor');
    expect(rutaDelPanel('GUARDIA')).toBe('/app/guardia');
    expect(rutaDelPanel('ADMIN')).toBe('/app/admin');
    expect(rutaDelPanel('SUPERADMIN')).toBe('/app/superadmin');
  });

  it('tolera espacios alrededor: un rol con espacio mandaba a una ruta que no existe', () => {
    expect(rutaDelPanel(' SUPERVISOR ')).toBe('/app/supervisor');
  });
});
