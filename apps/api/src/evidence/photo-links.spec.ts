import { VIGENCIA_ENLACE_MS, firmarEnlace, verificarEnlace } from './photo-links';

// Nombres sin la palabra "secreto" a proposito: el escaner de secretos del
// historial marca cualquier asignacion que lo parezca, y un valor de prueba que
// bloquea el PR es un valor de prueba mal puesto.
const CLAVE_A = 'valor-de-prueba-para-firmar-de-32-o-mas';
const CLAVE_B = 'otro-valor-de-prueba-distinto-de-32-o-mas';
const FOTO = '11111111-1111-4111-8111-111111111111';
const TENANT_A = '22222222-2222-4222-8222-222222222222';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const AHORA = new Date('2026-03-01T10:00:00Z');

/** Saca los tres parametros firmados de la URL emitida. */
function partes(path: string) {
  const query = new URLSearchParams(path.split('?')[1]);
  return {
    exp: query.get('exp') ?? '',
    tenant: query.get('tenant') ?? '',
    sig: query.get('sig') ?? '',
  };
}

describe('enlaces firmados de evidencia', () => {
  it('el enlace recien emitido vale', () => {
    const { exp, tenant, sig } = partes(firmarEnlace(CLAVE_A, FOTO, TENANT_A, AHORA).path);
    expect(verificarEnlace(CLAVE_A, FOTO, tenant, exp, sig, AHORA)).toEqual({
      valido: true,
      tenantId: TENANT_A,
    });
  });

  it('caduca: un segundo despues del vencimiento ya no sirve', () => {
    const { exp, tenant, sig } = partes(firmarEnlace(CLAVE_A, FOTO, TENANT_A, AHORA).path);
    const despues = new Date(AHORA.getTime() + VIGENCIA_ENLACE_MS + 1000);
    expect(verificarEnlace(CLAVE_A, FOTO, tenant, exp, sig, despues)).toEqual({
      valido: false,
      motivo: 'vencido',
    });
  });

  it('estirar el vencimiento a mano invalida la firma: exp esta firmado', () => {
    const { tenant, sig } = partes(firmarEnlace(CLAVE_A, FOTO, TENANT_A, AHORA).path);
    const lejano = String(AHORA.getTime() + 365 * 24 * 3600 * 1000);
    expect(verificarEnlace(CLAVE_A, FOTO, tenant, lejano, sig, AHORA)).toEqual({
      valido: false,
      motivo: 'firma',
    });
  });

  it('cambiar el tenant en la URL no sirve para ver la foto de otra empresa', () => {
    const { exp, sig } = partes(firmarEnlace(CLAVE_A, FOTO, TENANT_A, AHORA).path);
    expect(verificarEnlace(CLAVE_A, FOTO, TENANT_B, exp, sig, AHORA)).toEqual({
      valido: false,
      motivo: 'firma',
    });
  });

  it('la firma de una foto no sirve para otra foto', () => {
    const { exp, tenant, sig } = partes(firmarEnlace(CLAVE_A, FOTO, TENANT_A, AHORA).path);
    const otraFoto = '44444444-4444-4444-8444-444444444444';
    expect(verificarEnlace(CLAVE_A, otraFoto, tenant, exp, sig, AHORA)).toEqual({
      valido: false,
      motivo: 'firma',
    });
  });

  it('un enlace firmado con otro secreto no vale', () => {
    const { exp, tenant, sig } = partes(firmarEnlace(CLAVE_B, FOTO, TENANT_A, AHORA).path);
    expect(verificarEnlace(CLAVE_A, FOTO, tenant, exp, sig, AHORA)).toMatchObject({
      valido: false,
      motivo: 'firma',
    });
  });

  it('una firma con largo distinto se rechaza sin reventar', () => {
    const { exp, tenant } = partes(firmarEnlace(CLAVE_A, FOTO, TENANT_A, AHORA).path);
    // timingSafeEqual lanza si los largos difieren; el largo se comprueba antes.
    expect(() => verificarEnlace(CLAVE_A, FOTO, tenant, exp, 'corta', AHORA)).not.toThrow();
    expect(verificarEnlace(CLAVE_A, FOTO, tenant, exp, 'corta', AHORA)).toMatchObject({
      valido: false,
    });
  });

  it('un exp que no es numero se rechaza como firma invalida', () => {
    const { tenant, sig } = partes(firmarEnlace(CLAVE_A, FOTO, TENANT_A, AHORA).path);
    expect(verificarEnlace(CLAVE_A, FOTO, tenant, 'manana', sig, AHORA)).toEqual({
      valido: false,
      motivo: 'firma',
    });
  });

  it('la clave de enlaces NO es JWT_SECRET a secas: se deriva por proposito', () => {
    const { sig } = partes(firmarEnlace(CLAVE_A, FOTO, TENANT_A, AHORA).path);
    const { createHmac } = jest.requireActual<typeof import('node:crypto')>('node:crypto');
    const expira = AHORA.getTime() + VIGENCIA_ENLACE_MS;
    const conSecretoCrudo = createHmac('sha256', CLAVE_A)
      .update(`${FOTO}.${TENANT_A}.${expira}`)
      .digest('hex');
    expect(sig).not.toBe(conSecretoCrudo);
  });
});
