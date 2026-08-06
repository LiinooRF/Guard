/**
 * Pruebas de la traduccion API -> mapa de recintos (#75).
 *
 * Se prueba lo que se ve mal cuando falla, no que las funciones existan:
 *
 * - Un recinto con la latitud sin cargar dibujado en el Atlantico.
 * - Un punto que hereda la regla de foto descrito como "sin foto" —el mismo
 *   error que ya cometimos leyendo gpsSharingMandatory como interruptor—.
 * - Un id de recinto escrito a mano en la URL que se cuela en la pantalla del
 *   supervisor sin pasar por la lista que entrego el servidor.
 */

import {
  aNumero,
  armarMarcas,
  centroDelRecinto,
  coordenadaDe,
  detalleDelPunto,
  detalleDelRecinto,
  marcasDePuntosDeControl,
  marcasDeRecintos,
  recintoElegido,
  resumenDeUbicaciones,
  zoomDeLasReglas,
  type PuntoDeControlDelMapa,
  type RecintoDelMapa,
} from './mapa-recintos-datos';

const PROVIDENCIA: RecintoDelMapa = {
  id: 'r1',
  name: 'Sucursal Providencia',
  branchName: 'Zona Oriente',
  address: 'Av. Providencia 1234',
  latitude: -33.4262,
  longitude: -70.6169,
  isActive: true,
};

const LO_BOZA: RecintoDelMapa = {
  id: 'r2',
  name: 'Planta Lo Boza',
  branchName: 'Zona Norponiente',
  address: 'Lo Boza 220',
  latitude: -33.3785,
  longitude: -70.7429,
  isActive: true,
};

const SIN_UBICACION: RecintoDelMapa = {
  id: 'r3',
  name: 'Bodega Quilicura',
  branchName: 'Zona Norte',
  address: 'Camino a Quilicura s/n',
  latitude: null,
  longitude: null,
  isActive: true,
};

const PORTERIA: PuntoDeControlDelMapa = {
  id: 'c1',
  name: 'Portería',
  kind: 'acceso_critico',
  suggestedOrder: 1,
  latitude: -33.4263,
  longitude: -70.617,
  requiresPhoto: null,
  isActive: true,
};

const PASILLO: PuntoDeControlDelMapa = {
  id: 'c2',
  name: 'Pasillo central',
  kind: 'normal',
  suggestedOrder: 2,
  latitude: -33.4265,
  longitude: -70.6172,
  requiresPhoto: null,
  isActive: true,
};

describe('aNumero', () => {
  it('no confunde el campo vacío con el cero', () => {
    expect(aNumero(null)).toBeNull();
    expect(aNumero(undefined)).toBeNull();
    expect(aNumero('')).toBeNull();
    expect(aNumero('   ')).toBeNull();
  });

  it('lee el numeric que el driver puede entregar como texto', () => {
    expect(aNumero('-33.4262')).toBeCloseTo(-33.4262, 6);
    expect(aNumero(0)).toBe(0);
  });

  it('descarta lo que no es un número', () => {
    expect(aNumero('sur')).toBeNull();
    expect(aNumero(Number.NaN)).toBeNull();
  });
});

describe('coordenadaDe', () => {
  it('resuelve una coordenada de Santiago', () => {
    expect(coordenadaDe(PROVIDENCIA)).toEqual({ lat: -33.4262, lng: -70.6169 });
  });

  it('descarta el recinto con una sola de las dos coordenadas cargadas', () => {
    // Sin este control, Number(null) daria 0 y el recinto apareceria en medio
    // del Atlantico, a 4.000 km de donde esta.
    expect(coordenadaDe({ latitude: null, longitude: -70.6169 })).toBeNull();
    expect(coordenadaDe({ latitude: -33.4262, longitude: null })).toBeNull();
  });

  it('descarta el (0,0) del campo vacío mal convertido', () => {
    expect(coordenadaDe({ latitude: 0, longitude: 0 })).toBeNull();
  });

  it('descarta una coordenada fuera del planeta', () => {
    expect(coordenadaDe({ latitude: 91, longitude: -70 })).toBeNull();
  });
});

describe('marcasDeRecintos', () => {
  it('dibuja los recintos con ubicación y omite los que no la tienen', () => {
    const marcas = marcasDeRecintos([PROVIDENCIA, SIN_UBICACION, LO_BOZA]);
    expect(marcas.map((marca) => marca.id)).toEqual(['r1', 'r2']);
    expect(marcas.every((marca) => marca.variante === 'recinto')).toBe(true);
  });

  it('no dibuja un recinto dado de baja', () => {
    expect(marcasDeRecintos([{ ...PROVIDENCIA, isActive: false }])).toEqual([]);
  });

  it('trata el recinto sin el campo isActive como activo', () => {
    // Esta forma NO es inventada: es la de listAssignedSites() en
    // supervisor.service.ts, que hace SELECT s.id, s.name, s.branch_name,
    // s.address, s.timezone, s.latitude, s.longitude ... WHERE ss.supervisor_id
    // = $1 AND s.is_active. Filtra los inactivos en el WHERE, asi que no manda
    // isActive. Si algun dia lo agrega, este test sigue siendo valido; si
    // dejara de filtrar, hay que cambiar estaActivo, no este test.
    const comoLoDevuelveSupervisor: RecintoDelMapa = {
      id: 'r1',
      name: 'Sucursal Providencia',
      branchName: 'Zona Oriente',
      address: 'Av. Providencia 1234',
      latitude: -33.4262,
      longitude: -70.6169,
    };
    expect(marcasDeRecintos([comoLoDevuelveSupervisor])).toHaveLength(1);
  });

  it('arma el detalle con sucursal y dirección, sin dejar separadores sueltos', () => {
    expect(detalleDelRecinto(PROVIDENCIA)).toBe('Zona Oriente · Av. Providencia 1234');
    expect(detalleDelRecinto({ ...PROVIDENCIA, address: null })).toBe('Zona Oriente');
    expect(detalleDelRecinto({ ...PROVIDENCIA, address: '   ' })).toBe('Zona Oriente');
  });
});

describe('detalleDelPunto', () => {
  it('distingue los TRES estados de la foto, que no son un sí/no', () => {
    expect(detalleDelPunto({ ...PORTERIA, requiresPhoto: true })).toBe(
      'Acceso crítico · Pide foto siempre',
    );
    expect(detalleDelPunto({ ...PORTERIA, requiresPhoto: false })).toBe(
      'Acceso crítico · Sin foto, aunque las reglas la pidan',
    );
    // null NO es "sin foto": fuera de horario la regla igual la va a exigir.
    expect(detalleDelPunto({ ...PORTERIA, requiresPhoto: null })).toBe(
      'Acceso crítico · La foto la deciden las reglas',
    );
  });

  it('nombra el punto normal como tal', () => {
    expect(detalleDelPunto(PASILLO)).toBe('Punto normal · La foto la deciden las reglas');
  });
});

describe('marcasDePuntosDeControl', () => {
  it('pinta el acceso crítico distinto del punto normal', () => {
    const marcas = marcasDePuntosDeControl([PORTERIA, PASILLO]);
    expect(marcas[0]?.variante).toBe('alerta');
    expect(marcas[1]?.variante).toBe('punto');
  });

  it('numera con el orden sugerido y deja sin número el orden 0', () => {
    const marcas = marcasDePuntosDeControl([
      PORTERIA,
      { ...PASILLO, id: 'c3', suggestedOrder: 0 },
    ]);
    expect(marcas[0]?.numero).toBe(1);
    expect(marcas[1]?.numero).toBeUndefined();
  });

  it('omite el punto retirado y el que no tiene ubicación cargada', () => {
    const marcas = marcasDePuntosDeControl([
      { ...PORTERIA, isActive: false },
      { ...PASILLO, id: 'c4', latitude: null, longitude: null },
    ]);
    expect(marcas).toEqual([]);
  });
});

describe('armarMarcas', () => {
  const recintos = [PROVIDENCIA, LO_BOZA, SIN_UBICACION];

  it('sin recinto elegido muestra todos los recintos y ningún punto', () => {
    const marcas = armarMarcas({
      recintos,
      elegidoId: null,
      puntosDeControl: [PORTERIA, PASILLO],
    });
    expect(marcas.map((marca) => marca.id)).toEqual(['r1', 'r2']);
  });

  it('con recinto elegido muestra ese recinto y sus puntos de control', () => {
    const marcas = armarMarcas({
      recintos,
      elegidoId: 'r1',
      puntosDeControl: [PORTERIA, PASILLO],
    });
    expect(marcas.map((marca) => marca.id)).toEqual(['r1', 'c1', 'c2']);
  });

  it('dibuja los puntos aunque el recinto elegido no tenga ubicación cargada', () => {
    const marcas = armarMarcas({
      recintos,
      elegidoId: 'r3',
      puntosDeControl: [PORTERIA],
    });
    expect(marcas.map((marca) => marca.id)).toEqual(['c1']);
  });
});

describe('recintoElegido', () => {
  const recintos = [PROVIDENCIA, LO_BOZA];

  it('acepta un recinto de la lista que entregó el servidor', () => {
    expect(recintoElegido(recintos, 'r2')).toBe('r2');
  });

  it('ignora un id escrito a mano en la URL', () => {
    // Es el recorte del SUPERVISOR: su lista ya viene acotada a sus recintos
    // asignados (el JOIN con supervisor_sites de listAssignedSites), y eso no
    // puede saltarse cambiando la barra de direcciones.
    expect(recintoElegido(recintos, 'r9')).toBeNull();
    expect(recintoElegido(recintos, '../admin')).toBeNull();
  });

  it('trata la ausencia y el vacío como "sin elegir"', () => {
    expect(recintoElegido(recintos, null)).toBeNull();
    expect(recintoElegido(recintos, undefined)).toBeNull();
    expect(recintoElegido(recintos, '  ')).toBeNull();
  });

  it('no deja elegir un recinto dado de baja', () => {
    expect(recintoElegido([{ ...PROVIDENCIA, isActive: false }], 'r1')).toBeNull();
  });
});

describe('centroDelRecinto', () => {
  it('devuelve la ubicación del recinto elegido', () => {
    expect(centroDelRecinto([PROVIDENCIA, LO_BOZA], 'r2')).toEqual({
      lat: -33.3785,
      lng: -70.7429,
    });
  });

  it('devuelve null cuando no hay elección o el recinto no tiene ubicación', () => {
    expect(centroDelRecinto([PROVIDENCIA], null)).toBeNull();
    expect(centroDelRecinto([SIN_UBICACION], 'r3')).toBeNull();
  });
});

describe('resumenDeUbicaciones', () => {
  it('cuenta cuántos recintos activos tienen ubicación y cuántos no', () => {
    expect(
      resumenDeUbicaciones([
        PROVIDENCIA,
        LO_BOZA,
        SIN_UBICACION,
        { ...PROVIDENCIA, id: 'r4', isActive: false },
      ]),
    ).toEqual({ activos: 3, conUbicacion: 2, sinUbicacion: 1 });
  });
});

describe('zoomDeLasReglas', () => {
  it('devuelve undefined mientras mapDefaultZoom no exista en las reglas', () => {
    expect(zoomDeLasReglas({ complianceThreshold: 70 })).toBeUndefined();
    expect(zoomDeLasReglas(null)).toBeUndefined();
    expect(zoomDeLasReglas(undefined)).toBeUndefined();
  });

  it('usa el valor configurado cuando llega', () => {
    expect(zoomDeLasReglas({ mapDefaultZoom: 15 })).toBe(15);
  });

  it('descarta un valor que dejaría el mapa en gris', () => {
    expect(zoomDeLasReglas({ mapDefaultZoom: 40 })).toBeUndefined();
    expect(zoomDeLasReglas({ mapDefaultZoom: 0 })).toBeUndefined();
    expect(zoomDeLasReglas({ mapDefaultZoom: 16.5 })).toBeUndefined();
    expect(zoomDeLasReglas({ mapDefaultZoom: '17' })).toBeUndefined();
  });
});
