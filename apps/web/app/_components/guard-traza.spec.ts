import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  acumular,
  colaVacia,
  loteParaEnviar,
  trasEnviar,
  MAX_PUNTOS_EN_COLA,
} from './guard-traza';

/**
 * La traza en vivo (#280): la cola del portal y el CABLEADO del emisor.
 *
 * El defecto de fondo era el de la familia entera: endpoint, tabla, mapa del
 * supervisor, reglas y aviso legal existian, y nadie enviaba posiciones. Como
 * en #275 y #117, la mitad del spec que importa es la que lee el fuente y
 * exige que alguien llame.
 */

const punto = (n: number) => ({
  recordedAt: new Date(1754690000000 + n * 60_000).toISOString(),
  latitude: -33.4 - n * 0.001,
  longitude: -70.6,
});

describe('la cola de la traza', () => {
  it('acumula y entrega todo lo pendiente en UN lote', () => {
    let cola = colaVacia();
    for (let i = 0; i < 3; i += 1) cola = acumular(cola, punto(i));
    expect(loteParaEnviar(cola)).toHaveLength(3);
  });

  it('enviado: la cola queda vacia', () => {
    let cola = acumular(colaVacia(), punto(1));
    cola = trasEnviar(cola, 1, 'enviado');
    expect(loteParaEnviar(cola)).toHaveLength(0);
  });

  it('sin señal se conserva TODO: el guardia trabaja donde no hay señal', () => {
    // Regla 4 de CLAUDE.md. Perder puntos por un POST caido seria perder justo
    // los tramos del subterraneo, que son los que mas explican un recorrido.
    let cola = acumular(acumular(colaVacia(), punto(1)), punto(2));
    cola = trasEnviar(cola, 2, 'fallo-red');
    expect(loteParaEnviar(cola)).toHaveLength(2);
  });

  it('el rechazo del servidor descarta el lote: es la politica hablando', () => {
    // Un 403 aqui es consentimiento revocado o turno terminado. Insistir seria
    // pelear contra "no se rastrea fuera del turno".
    let cola = acumular(colaVacia(), punto(1));
    cola = trasEnviar(cola, 1, 'rechazado');
    expect(loteParaEnviar(cola)).toHaveLength(0);
  });

  it('los puntos que llegan DURANTE el envio no se pierden con el resultado', () => {
    // La carrera real: el POST viaja con N puntos y el shell emite otro antes
    // de la respuesta. `trasEnviar` descuenta solo los enviados.
    let cola = acumular(acumular(colaVacia(), punto(1)), punto(2));
    const lote = loteParaEnviar(cola); // viajan 2
    cola = acumular(cola, punto(3)); // llega uno mas en vuelo
    cola = trasEnviar(cola, lote.length, 'enviado');
    expect(loteParaEnviar(cola)).toHaveLength(1);
    expect(loteParaEnviar(cola)[0]).toEqual(punto(3));
  });

  it('sobre el tope cae el punto MAS VIEJO: el final del recorrido explica mas', () => {
    let cola = colaVacia();
    for (let i = 0; i <= MAX_PUNTOS_EN_COLA; i += 1) cola = acumular(cola, punto(i));
    expect(loteParaEnviar(cola)).toHaveLength(MAX_PUNTOS_EN_COLA);
    expect(loteParaEnviar(cola)[0]).toEqual(punto(1)); // el 0 se descarto
  });
});

describe('el cableado: que esta vez SI emita alguien', () => {
  const leer = (ruta: string) => readFileSync(join(__dirname, ruta), 'utf8');

  it('la pantalla de la ronda enciende la traza, atada al cierre', () => {
    const fuente = leer('guard-shift.tsx');
    expect(fuente).toContain('useTrazaEnVivo(');
    // Atada al CIERRE de la ronda: el grifo se corta al cerrar, no al desmontar
    // por casualidad. "No se rastrea fuera del turno" es demostrable o no es.
    expect(fuente).toMatch(/useTrazaEnVivo\(\{[^}]*activa: estado\.cierre === undefined/);
  });

  it('el emisor pide el plan al SERVIDOR y sube al endpoint real', () => {
    const fuente = leer('use-guard-traza.ts');
    expect(fuente).toContain('/geo/policy');
    expect(fuente).toContain('/geo/patrols/');
    expect(fuente).toContain('/track');
    // Y sin plan que registre recorrido, el grifo ni se abre.
    expect(fuente).toContain('tracksLocation');
  });

  it('el desmontaje manda track.stop pase lo que pase', () => {
    const fuente = leer('use-guard-traza.ts');
    expect(fuente).toMatch(/return \(\) => \{[\s\S]*?detenerTraza\(\)/);
  });

  it('el puente del portal expone la capacidad y degrada con shell viejo', () => {
    const fuente = leer('use-guard-bridge.ts');
    expect(fuente).toContain('MINOR_CON_TRAZA = 5');
    expect(fuente).toContain('soportaTraza');
  });

  it('las DOS copias del protocolo conocen la familia track.*', () => {
    // El protocolo vive duplicado a proposito (shell y portal): si una copia
    // se queda atras, el mensaje se descarta en silencio.
    for (const ruta of [
      join(__dirname, '..', '_lib', 'bridge', 'protocol.ts'),
      join(__dirname, '..', '..', '..', 'mobile', 'src', 'bridge', 'protocol.ts'),
    ]) {
      const fuente = readFileSync(ruta, 'utf8');
      expect(fuente).toContain("'track.start'");
      expect(fuente).toContain("'track.point'");
      expect(fuente).toContain('PROTOCOLO_MINOR = 5');
    }
  });
});
