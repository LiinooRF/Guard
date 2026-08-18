import { BrandingService } from './branding.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { checkContrast, contrastRatio } from '@sentrycore/shared';

const ctx = (query: jest.Mock) => ({ manager: { query } }) as unknown as TenantContextService;

describe('contraste WCAG', () => {
  it('negro sobre blanco da el maximo teorico de 21:1', () => {
    expect(Math.round(contrastRatio('#000000', '#ffffff'))).toBe(21);
  });

  it('un amarillo claro NO pasa sobre el fondo del panel: 1.3:1', () => {
    const r = checkContrast('#ffe066');
    expect(r.passes).toBe(false);
    expect(r.onSurface).toBeLessThan(2);
    // como relleno de un boton si sirve, con texto oscuro encima
    expect(r.fillText).toBe('#111111');
    expect(r.fillRatio).toBeGreaterThan(4.5);
  });

  it('un azul corporativo oscuro pasa y pide texto blanco como relleno', () => {
    const r = checkContrast('#1f3b73');
    expect(r.passes).toBe(true);
    expect(r.fillText).toBe('#ffffff');
  });
});

describe('BrandingService', () => {
  it('sin fila configurada devuelve los defaults del producto', async () => {
    const query = jest.fn().mockResolvedValue([]);
    await expect(new BrandingService(ctx(query)).current()).resolves.toMatchObject({
      primaryColor: '#1f3b73',
      commercialName: null,
    });
  });

  it('el tema trae variables CSS listas para inyectar en el servidor', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        commercial_name: 'Seguridad Andina',
        logo_uri: null,
        primary_color: '#1f3b73',
        primary_text_color: '#f8fafc',
        secondary_color: '#4263eb',
        mail_from_name: null,
        mail_footer: null,
      },
    ]);
    const tema = await new BrandingService(ctx(query)).theme();
    expect(tema.cssVariables['--marca-primario']).toBe('#1f3b73');
    expect(tema.cssVariables['--marca-primario-texto']).toBe('#f8fafc');
    expect(tema.contrast.primary.passes).toBe(true);
  });

  it('RECHAZA un texto sin contraste contra el color principal', async () => {
    const query = jest.fn();
    await expect(
      new BrandingService(ctx(query)).replace({
        primaryColor: '#6040a8',
        primaryTextColor: '#3048bc',
      }),
    ).rejects.toThrow(/texto .* contraste/i);
    expect(query).not.toHaveBeenCalled();
  });

  it('RECHAZA guardar un color de bajo contraste, con el ratio y el porque', async () => {
    const query = jest.fn();
    await expect(
      new BrandingService(ctx(query)).replace({ primaryColor: '#ffe066' }),
    ).rejects.toThrow(/contraste .* sobre fondo/);
    // no llego a escribir nada
    expect(query).not.toHaveBeenCalled();
  });

  it('para documentos cae al nombre legal si no hay nombre comercial', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([]) // sin branding configurado
      .mockResolvedValueOnce([{ display_name: 'Andina Seguridad', legal_name: 'Andina Seguridad SpA' }]);
    await expect(new BrandingService(ctx(query)).forDocuments()).resolves.toMatchObject({
      displayName: 'Andina Seguridad',
      mailFromName: 'Andina Seguridad',
    });
    // Las columnas del mock son las REALES de la tabla. Un mock con una columna
    // inventada hace pasar el test y revienta en produccion: fue exactamente lo
    // que paso con "name", que no existe en tenants.
    expect(query.mock.calls[1][0]).toMatch(/display_name/);
    expect(query.mock.calls[1][0]).not.toMatch(/SELECT name/);
  });

  it('el nombre comercial gana sobre el legal en informes y correos', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{
        commercial_name: 'Andina', logo_uri: null,
        primary_color: '#1f3b73', primary_text_color: '#ffffff', secondary_color: '#4263eb',
        mail_from_name: null, mail_footer: 'Andina · Seguridad 24/7',
      }])
      .mockResolvedValueOnce([{ display_name: 'Andina Seguridad', legal_name: 'Andina Seguridad SpA' }]);
    await expect(new BrandingService(ctx(query)).forDocuments()).resolves.toMatchObject({
      displayName: 'Andina',
      mailFromName: 'Andina',
      mailFooter: 'Andina · Seguridad 24/7',
    });
  });
});
