import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { dispositivoDuplicado, velocidadImposible } from './anomalias-de-secuencia';

/**
 * Las anomalias de secuencia (#60): el antifraude que estaba declarado con
 * CERO escritores. Este spec tiene las dos mitades de siempre — la logica y el
 * cableado — porque la enfermedad de esta familia nunca fue el calculo, fue
 * que nadie lo llamara.
 */

const T0 = new Date('2026-08-08T22:00:00Z');
const seg = (n: number) => new Date(T0.getTime() + n * 1000);

/** Dos puntos reales de Santiago separados ~1 km (Plaza de Armas -> Sta. Lucia). */
const PUNTO_A = { latitude: -33.4372, longitude: -70.6506 };
const PUNTO_B = { latitude: -33.4404, longitude: -70.6438 };
/** Y dos del mismo recinto, a ~80 m. */
const CERCA_A = { latitude: -33.4372, longitude: -70.6506 };
const CERCA_B = { latitude: -33.4379, longitude: -70.6503 };

describe('velocidadImposible', () => {
  it('EL CRITERIO DEL ISSUE: dos puntos a 1 km escaneados con 10 segundos de diferencia', () => {
    // El guardia que se llevo las etiquetas a la caseta. 1 km en 10 s son
    // ~360 km/h: nadie camina asi. Esta es la señal por la que existe #60.
    expect(
      velocidadImposible({ ...PUNTO_A, at: T0 }, { ...PUNTO_B, at: seg(10) }, 15),
    ).toBe(true);
  });

  it('el mismo kilometro caminado en 12 minutos pasa limpio', () => {
    // ~5 km/h: una ronda normal. La marca es para lo imposible, no lo lento.
    expect(
      velocidadImposible({ ...PUNTO_A, at: T0 }, { ...PUNTO_B, at: seg(12 * 60) }, 15),
    ).toBe(false);
  });

  it('dos puntos del mismo pasillo con un minuto entre medio pasan limpios', () => {
    // ~80 m en 60 s = ~4.8 km/h. El caso de todos los dias.
    expect(
      velocidadImposible({ ...CERCA_A, at: T0 }, { ...CERCA_B, at: seg(60) }, 15),
    ).toBe(false);
  });

  it('dos escaneos en el MISMO segundo a un kilometro: la version descarada', () => {
    // El tiempo se pisa a un minimo de 1 s: la division por cero no es un
    // veredicto, y este es justamente el fraude mas burdo.
    expect(
      velocidadImposible({ ...PUNTO_A, at: T0 }, { ...PUNTO_B, at: T0 }, 15),
    ).toBe(true);
  });

  it('un punto sin coordenadas NO se puede medir: false, nunca un falso positivo', () => {
    // El panel ya avisa que puntos estan sin coordenadas y que eso apaga la
    // validacion GPS; marcar fraude sobre un dato que no existe castigaria al
    // guardia por la pereza del que configuro el recinto.
    expect(
      velocidadImposible({ latitude: null, longitude: null, at: T0 },
        { ...PUNTO_B, at: seg(5) }, 15),
    ).toBe(false);
    expect(
      velocidadImposible({ ...PUNTO_A, at: T0 },
        { latitude: null, longitude: null, at: seg(5) }, 15),
    ).toBe(false);
  });

  it('el umbral es LA REGLA, no un numero fijo: con 100 km/h el mismo caso pasa', () => {
    // 1 km en 45 s ~ 80 km/h: imposible a pie (umbral 15), permitido si la
    // empresa configura 100 (rondas en vehiculo existen).
    const previo = { ...PUNTO_A, at: T0 };
    const actual = { ...PUNTO_B, at: seg(45) };
    expect(velocidadImposible(previo, actual, 15)).toBe(true);
    expect(velocidadImposible(previo, actual, 100)).toBe(false);
  });
});

describe('dispositivoDuplicado', () => {
  it('la ronda firmada por el telefono A recibe un escaneo del telefono B', () => {
    // "Le presto el telefono a un compañero": el otro fraude del issue.
    expect(dispositivoDuplicado(['tel-A', 'tel-A'], 'tel-B')).toBe(true);
  });

  it('el mismo telefono toda la ronda pasa limpio', () => {
    expect(dispositivoDuplicado(['tel-A', 'tel-A'], 'tel-A')).toBe(false);
  });

  it('el primer escaneo de la ronda no tiene contra que compararse', () => {
    expect(dispositivoDuplicado([], 'tel-A')).toBe(false);
  });

  it('el escaneo legacy (sin dispositivo) no participa: ya lleva su propia marca', () => {
    // Sumarle esta seria contarle firma_dispositivo_ausente dos veces.
    expect(dispositivoDuplicado(['tel-A'], null)).toBe(false);
  });

  it('los previos sin dispositivo no convierten en sospechoso al primero firmado', () => {
    expect(dispositivoDuplicado([null, null], 'tel-A')).toBe(false);
  });
});

describe('el cableado: que esta vez SI las escriba alguien', () => {
  // La enfermedad original: `velocidad_imposible` y `dispositivo_duplicado`
  // declaradas en scanAnomalySchema, dibujadas por el informe, con etiqueta en
  // el portal, y CERO escritores en apps/api/src. Se prueba leyendo el fuente
  // porque lo que hay que garantizar es la LLAMADA, no el calculo.
  const servicio = readFileSync(join(__dirname, 'guard.service.ts'), 'utf8');

  it('registerScan consulta los escaneos previos con las coordenadas del punto', () => {
    expect(servicio).toContain('FROM scans sc');
    expect(servicio).toMatch(/JOIN checkpoints c ON c\.tenant_id = sc\.tenant_id/);
  });

  it('y empuja las dos anomalias al arreglo que viaja en el INSERT', () => {
    expect(servicio).toMatch(/anomalies\.push\('velocidad_imposible'\)/);
    expect(servicio).toMatch(/anomalies\.push\('dispositivo_duplicado'\)/);
  });

  it('la velocidad usa la REGLA del recinto, no un numero escrito en el servicio', () => {
    expect(servicio).toContain('rules.impossibleSpeedKmh');
  });
});
