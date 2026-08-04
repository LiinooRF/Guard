import {
  DEEP_LINK_MAJOR,
  datosDeDeepLink,
  deepLinkDeEvento,
  deepLinkDeRonda,
  leerDeepLink,
  rutaDePortal,
} from './deep-link';

const EVENTO = '11111111-1111-4111-8111-111111111111';
const RECINTO = '22222222-2222-4222-8222-222222222222';
const RONDA = '33333333-3333-4333-8333-333333333333';

describe('deep link — payload (#113)', () => {
  it('viaja como pares de strings, que es lo unico que acepta el transporte', () => {
    const datos = datosDeDeepLink(deepLinkDeEvento(EVENTO, RECINTO));

    expect(datos).toEqual({
      dl: String(DEEP_LINK_MAJOR),
      destino: 'evento',
      id: EVENTO,
      siteId: RECINTO,
    });
    for (const valor of Object.values(datos)) {
      expect(typeof valor).toBe('string');
    }
  });

  it('ida y vuelta: lo que arma el servidor es lo que lee la app', () => {
    const original = deepLinkDeRonda(RONDA, RECINTO);
    const lectura = leerDeepLink(datosDeDeepLink(original));

    expect(lectura.ok).toBe(true);
    expect(lectura.deepLink).toEqual(original);
    expect(rutaDePortal(lectura.deepLink)).toBe(`/app/rondas/${RONDA}`);
  });
});

describe('deep link — degradado (#113)', () => {
  it('una version que este build no soporta abre el inicio, no falla', () => {
    // El servidor se despliega en minutos; el shell tarda semanas en
    // actualizarse. Este caso pasa el dia del deploy, no en un caso raro.
    const lectura = leerDeepLink({ dl: '9', destino: 'evento', id: EVENTO });

    expect(lectura).toEqual({
      ok: false,
      motivo: 'version-no-soportada',
      deepLink: { destino: 'inicio' },
    });
    expect(rutaDePortal(lectura.deepLink)).toBe('/app');
  });

  it('un destino desconocido abre el inicio en vez de adivinar', () => {
    const lectura = leerDeepLink({ dl: '1', destino: 'checklist', id: EVENTO });

    expect(lectura.ok).toBe(false);
    expect(lectura.deepLink).toEqual({ destino: 'inicio' });
  });

  it('sin payload, o con uno vacío, abre el inicio', () => {
    const sinDatos = leerDeepLink(undefined);
    const vacio = leerDeepLink({});

    expect(sinDatos.ok).toBe(false);
    expect(sinDatos.deepLink).toEqual({ destino: 'inicio' });
    expect(vacio.ok).toBe(false);
    expect(vacio.deepLink).toEqual({ destino: 'inicio' });
  });

  it('rechaza referencias que no sean UUID: la id termina en una ruta del portal', () => {
    for (const id of ['../../admin', 'a/b', '1234', '', '%2e%2e']) {
      const lectura = leerDeepLink({ dl: '1', destino: 'evento', id });
      expect(lectura.ok).toBe(false);
      expect(rutaDePortal(lectura.deepLink)).toBe('/app');
    }
  });

  it('la ruta es relativa: el origen lo pone el shell, no la notificacion', () => {
    const ruta = rutaDePortal(deepLinkDeEvento(EVENTO, RECINTO));

    expect(ruta.startsWith('/')).toBe(true);
    expect(ruta.startsWith('//')).toBe(false);
    expect(ruta).not.toContain(':');
  });
});
