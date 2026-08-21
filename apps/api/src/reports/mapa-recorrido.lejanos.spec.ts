/**
 * Un punto en otra ubicacion no puede dejar ilegible el plano de la ronda.
 *
 * EL CASO REAL (Janssen, 21-08-2026)
 * ---------------------------------------------------------------------------
 * Una ronda de dieciseis puntos: catorce dentro de un recinto de 157 metros y
 * dos en otra instalacion, a 6,9 km. Las coordenadas de los dos lejanos estan
 * BIEN — la ronda cubre las dos ubicaciones a proposito.
 *
 * El plano tenia que encuadrar 4.170 metros para incluirlos a todos, asi que el
 * recorrido real quedaba ocupando el 2,6 % del ancho de la hoja: dos circulitos
 * sueltos y una barra de escala marcando 2 km. El informe salia sin errores y
 * sin mapa util, que es la peor combinacion posible.
 */

import {
  ajustarACaja,
  construirMapaRecorrido,
  expandirAProporcion,
  type EntradaMapa,
} from './mapa-recorrido.model';
import { armarNotas } from './mapa-recorrido.renderer';

function punto(numero: number, id: string, nombre: string) {
  return {
    numero, checkpointId: id, nombre, esCierre: false, esCritico: false,
    omitido: false, escaneadoEn: null, metodo: 'nfc', anomalias: [], instrucciones: null,
  };
}

/** Recinto compacto: catorce puntos repartidos en ~150 m. */
const CERCANOS = Array.from({ length: 14 }, (_, i) => ({
  id: `c${i}`,
  lat: -33.3812 - i * 0.0001,
  lng: -70.6925 - (i % 4) * 0.0002,
}));
/** Y dos en otra instalacion, a casi 7 km. */
const LEJANOS = [
  { id: 'lejos-1', lat: -33.434402, lng: -70.730301 },
  { id: 'lejos-2', lat: -33.434405, lng: -70.730295 },
];

function entrada(incluirLejanos: boolean): EntradaMapa {
  const todos = incluirLejanos ? [...CERCANOS, ...LEJANOS] : CERCANOS;
  return {
    puntos: todos.map((c, i) => punto(i + 1, c.id, c.id.startsWith('lejos') ? `Sucursal ${i}` : `Punto ${i + 1}`)) as never,
    coordenadas: todos.map((c) => ({ id: c.id, latitude: String(c.lat), longitude: String(c.lng) })),
    traza: CERCANOS.map((c, i) => ({
      recorded_at_device: new Date(Date.UTC(2026, 7, 21, 17, i)),
      latitude: String(c.lat), longitude: String(c.lng), accuracy_m: '20',
    })),
    escaneos: [],
    recinto: { latitude: '-33.3813', longitude: '-70.6921' },
    maxErrorTrazaM: 100, maxPuntosTraza: 500, trazaActivada: true,
  };
}

const lado = (m: ReturnType<typeof construirMapaRecorrido>) =>
  m.encuadre.esteMax - m.encuadre.esteMin;

describe('puntos de la ronda en otra ubicación', () => {
  it('el plano se encuadra sobre el recinto, no sobre el punto lejano', () => {
    const conLejanos = construirMapaRecorrido(entrada(true));
    const sinLejanos = construirMapaRecorrido(entrada(false));
    // El encuadre tiene que ser practicamente el mismo con y sin los lejanos.
    expect(lado(conLejanos)).toBeLessThan(lado(sinLejanos) * 1.5);
    // Y sobre todo: nada de kilometros para un recinto de 150 metros.
    expect(lado(conLejanos)).toBeLessThan(600);
  });

  it('los puntos lejanos no se pierden: se cuentan con su distancia', () => {
    const mapa = construirMapaRecorrido(entrada(true));
    expect(mapa.puntosFueraDelPlano).toHaveLength(2);
    for (const lejano of mapa.puntosFueraDelPlano) {
      expect(lejano.distanciaM).toBeGreaterThan(5000);
      expect(lejano.nombre).toContain('Sucursal');
    }
  });

  it('el informe lo dice al pie, con nombre y distancia', () => {
    const notas = armarNotas(construirMapaRecorrido(entrada(true)));
    const nota = notas.find((n) => n.includes('fuera del plano'));
    expect(nota).toBeDefined();
    expect(nota).toContain('otra ubicación');
    expect(nota).toMatch(/Sucursal/);
  });

  it('un recinto normal no pierde ni un punto', () => {
    const mapa = construirMapaRecorrido(entrada(false));
    expect(mapa.puntosFueraDelPlano).toHaveLength(0);
    expect(mapa.puntos).toHaveLength(14);
  });

  /*
   * Si TODO esta lejos de todo —una ronda entre ciudades— no hay nucleo que
   * privilegiar: se dibuja igual, feo pero completo. Nunca un plano vacio.
   */
  it('si no hay un núcleo claro, no se aparta nada', () => {
    const dispersos = [
      { id: 'a', lat: -33.38, lng: -70.69 },
      { id: 'b', lat: -33.45, lng: -70.75 },
      { id: 'c', lat: -33.52, lng: -70.81 },
    ];
    const mapa = construirMapaRecorrido({
      ...entrada(false),
      puntos: dispersos.map((d, i) => punto(i + 1, d.id, `Zona ${i + 1}`)) as never,
      coordenadas: dispersos.map((d) => ({ id: d.id, latitude: String(d.lat), longitude: String(d.lng) })),
      traza: [],
    });
    expect(mapa.puntos.length + mapa.puntosFueraDelPlano.length).toBe(3);
    expect(mapa.puntos.length).toBeGreaterThan(0);
  });
});

/**
 * El plano tiene que LLENAR la caja del informe.
 *
 * El encuadre sale del contenido y la caja es apaisada, asi que un recinto mas
 * alto que ancho se dibujaba centrado ocupando 149 de 495 puntos: dos tercios
 * de la hoja en blanco, con el mapa reducido a una estampilla.
 */
describe('encuadre contra la caja del informe', () => {
  const CAJA = { x: 0, y: 0, ancho: 495, alto: 230 };

  it('estira el encuadre hasta la proporción de la caja', () => {
    const alto = { esteMin: -80, esteMax: 80, norteMin: -100, norteMax: 100 };
    const expandido = expandirAProporcion(alto, CAJA);
    const proporcion =
      (expandido.esteMax - expandido.esteMin) / (expandido.norteMax - expandido.norteMin);
    expect(proporcion).toBeCloseTo(CAJA.ancho / CAJA.alto, 2);
  });

  it('solo agranda: ningún punto puede quedar fuera por estirar', () => {
    const original = { esteMin: -80, esteMax: 80, norteMin: -100, norteMax: 100 };
    const expandido = expandirAProporcion(original, CAJA);
    expect(expandido.esteMin).toBeLessThanOrEqual(original.esteMin);
    expect(expandido.esteMax).toBeGreaterThanOrEqual(original.esteMax);
    expect(expandido.norteMin).toBeLessThanOrEqual(original.norteMin);
    expect(expandido.norteMax).toBeGreaterThanOrEqual(original.norteMax);
  });

  it('el plano ocupa la caja entera, no una estampilla centrada', () => {
    const alto = { esteMin: -80, esteMax: 80, norteMin: -100, norteMax: 100 };
    const ajuste = ajustarACaja(expandirAProporcion(alto, CAJA), CAJA);
    expect(ajuste.anchoPx).toBeCloseTo(CAJA.ancho, 0);
    expect(ajuste.altoPx).toBeCloseTo(CAJA.alto, 0);
  });

  it('un recinto ya apaisado no se toca', () => {
    const apaisado = { esteMin: -247.5, esteMax: 247.5, norteMin: -115, norteMax: 115 };
    const expandido = expandirAProporcion(apaisado, CAJA);
    expect(expandido.esteMax - expandido.esteMin).toBeCloseTo(495, 0);
    expect(expandido.norteMax - expandido.norteMin).toBeCloseTo(230, 0);
  });
});
