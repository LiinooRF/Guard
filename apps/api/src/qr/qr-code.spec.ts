import {
  ZONA_QUIETA,
  bitsFormato,
  bitsVersion,
  correccionReedSolomon,
  polinomioGenerador,
  qrMatriz,
  qrSvg,
  qrTramos,
} from './qr-code';

/**
 * El codificador es propio, asi que se verifica contra valores PUBLICADOS de la
 * norma, no contra si mismo: informacion de formato y de version, generador
 * Reed-Solomon, capacidades por version y el vector conocido "HELLO WORLD".
 * Un simbolo mal formado no falla ruidosamente — falla el dia que un guardia
 * intenta escanear con el NFC ya roto.
 */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
})();

describe('qr-code — tablas de la norma', () => {
  it('la informacion de formato de nivel Q coincide con la tabla publicada', () => {
    const publicados = [0x355f, 0x3068, 0x3f31, 0x3a06, 0x24b4, 0x2183, 0x2eda, 0x2bed];
    expect(publicados.map((_, mascara) => bitsFormato(mascara))).toEqual(publicados);
  });

  it('la informacion de version coincide con la tabla publicada', () => {
    expect(bitsVersion(7)).toBe(0x07c94);
    expect(bitsVersion(8)).toBe(0x085bc);
    expect(bitsVersion(9)).toBe(0x09a99);
    expect(bitsVersion(10)).toBe(0x0a4d3);
  });

  it('el generador Reed-Solomon de grado 10 tiene los exponentes publicados', () => {
    const exponentes = polinomioGenerador(10).map((coeficiente) => LOG[coeficiente]!);
    expect(exponentes).toEqual([0, 251, 67, 46, 61, 118, 70, 64, 94, 32, 45]);
  });

  it('reproduce la correccion del ejemplo canonico HELLO WORLD en 1-Q', () => {
    const datos = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236];
    expect(correccionReedSolomon(datos, 13)).toEqual([
      168, 72, 22, 82, 217, 54, 156, 0, 46, 15, 180, 122, 16,
    ]);
  });

  it('elige la version minima que respeta la capacidad publicada de nivel Q', () => {
    const capacidades = [11, 20, 32, 46, 60, 74, 86, 108, 130, 151];
    capacidades.forEach((capacidad, indice) => {
      const version = indice + 1;
      expect(qrMatriz('A'.repeat(capacidad)).size).toBe(4 * version + 17);
      if (version < 10) {
        expect(qrMatriz('A'.repeat(capacidad + 1)).size).toBe(4 * (version + 1) + 17);
      }
    });
  });

  it('un payload que no cabe lanza en vez de emitir un simbolo truncado', () => {
    expect(() => qrMatriz('X'.repeat(152))).toThrow('excede la capacidad');
  });
});

describe('qr-code — simbolo generado', () => {
  const uid = 'VXQ-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const matriz = qrMatriz(uid);

  it('un UID de etiqueta entra en la version 3 (29x29)', () => {
    expect(matriz.size).toBe(29);
  });

  it('dibuja los tres patrones de deteccion', () => {
    const patron = [
      '#######',
      '#     #',
      '# ### #',
      '# ### #',
      '# ### #',
      '#     #',
      '#######',
    ];
    const leer = (ox: number, oy: number) =>
      patron.map((_, y) =>
        patron[y]!
          .split('')
          .map((_celda, x) => (matriz.modules[oy + y]![ox + x] ? '#' : ' '))
          .join(''),
      );
    expect(leer(0, 0)).toEqual(patron);
    expect(leer(matriz.size - 7, 0)).toEqual(patron);
    expect(leer(0, matriz.size - 7)).toEqual(patron);
  });

  it('dibuja los patrones de tiempo y el modulo oscuro fijo', () => {
    for (let i = 8; i < matriz.size - 8; i += 1) {
      expect(matriz.modules[6]![i]).toBe(i % 2 === 0);
      expect(matriz.modules[i]![6]).toBe(i % 2 === 0);
    }
    expect(matriz.modules[matriz.size - 8]![8]).toBe(true);
  });

  it('el contenido se recupera leyendo los modulos: el payload es el UID', () => {
    expect(leerPayload(matriz.modules, 3)).toBe(uid);
  });

  it('el SVG lleva la zona quieta de 4 modulos y fondo blanco', () => {
    const lado = matriz.size + ZONA_QUIETA * 2;
    const svg = qrSvg(uid);
    expect(svg).toContain(`viewBox="0 0 ${lado} ${lado}"`);
    expect(svg).toContain(`<rect width="${lado}" height="${lado}" fill="#ffffff"/>`);
    expect(svg.startsWith('<svg')).toBe(true);
  });

  it('los tramos horizontales cubren exactamente los modulos oscuros', () => {
    const oscuros = matriz.modules.reduce(
      (suma, fila) => suma + fila.filter(Boolean).length,
      0,
    );
    const cubiertos = qrTramos(matriz).reduce((suma, tramo) => suma + tramo.largo, 0);
    expect(cubiertos).toBe(oscuros);
  });
});

// ---------------------------------------------------------------------------

/** Lector minimo e independiente: deshace mascara e intercalado del simbolo. */
function leerPayload(modulos: readonly (readonly boolean[])[], version: number): string {
  const size = modulos.length;
  const funcion = matrizFuncion(size, version);

  let formato = 0;
  const leidos: boolean[] = [];
  for (let i = 0; i <= 5; i += 1) leidos.push(modulos[i]![8]!);
  leidos.push(modulos[7]![8]!, modulos[8]![8]!, modulos[8]![7]!);
  for (let i = 9; i < 15; i += 1) leidos.push(modulos[8]![14 - i]!);
  leidos.forEach((valor, indice) => {
    if (valor) formato |= 1 << indice;
  });
  const mascara = ((formato ^ 0x5412) >>> 10) & 7;

  const bits: number[] = [];
  for (let derecha = size - 1; derecha >= 1; derecha -= 2) {
    if (derecha === 6) derecha = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = derecha - j;
        const y = ((derecha + 1) & 2) === 0 ? size - 1 - vertical : vertical;
        if (funcion[y]![x]) continue;
        bits.push(modulos[y]![x] !== condicion(mascara, x, y) ? 1 : 0);
      }
    }
  }

  const codewords: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j]!;
    codewords.push(byte);
  }

  // Version 3 nivel Q: dos bloques de 17 codewords de datos, intercalados.
  const bloques: number[][] = [[], []];
  for (let i = 0; i < 34; i += 1) bloques[i % 2]!.push(codewords[i]!);
  const datos = [...bloques[0]!, ...bloques[1]!];

  const flujo: number[] = [];
  for (const byte of datos) for (let i = 7; i >= 0; i -= 1) flujo.push((byte >>> i) & 1);
  let cursor = 0;
  const tomar = (cantidad: number) => {
    let valor = 0;
    for (let i = 0; i < cantidad; i += 1) valor = (valor << 1) | flujo[cursor + i]!;
    cursor += cantidad;
    return valor;
  };
  expect(tomar(4)).toBe(0b0100); // modo byte
  const largo = tomar(version < 10 ? 8 : 16);
  let texto = '';
  for (let i = 0; i < largo; i += 1) texto += String.fromCharCode(tomar(8));
  return texto;
}

function matrizFuncion(size: number, version: number): boolean[][] {
  const usado = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const marcar = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < size && y < size) usado[y]![x] = true;
  };
  for (let dy = 0; dy < 8; dy += 1) {
    for (let dx = 0; dx < 8; dx += 1) {
      marcar(dx, dy);
      marcar(size - 1 - dx, dy);
      marcar(dx, size - 1 - dy);
    }
  }
  for (let i = 0; i < size; i += 1) {
    marcar(6, i);
    marcar(i, 6);
  }
  for (let i = 0; i < 9; i += 1) {
    marcar(8, i);
    marcar(i, 8);
  }
  for (let i = 0; i < 8; i += 1) {
    marcar(size - 1 - i, 8);
    marcar(8, size - 1 - i);
  }
  const centros = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]][version - 1] ?? [];
  for (let i = 0; i < centros.length; i += 1) {
    for (let j = 0; j < centros.length; j += 1) {
      const esquina =
        (i === 0 && j === 0) ||
        (i === 0 && j === centros.length - 1) ||
        (i === centros.length - 1 && j === 0);
      if (esquina) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) marcar(centros[j]! + dx, centros[i]! + dy);
      }
    }
  }
  return usado;
}

function condicion(mascara: number, x: number, y: number): boolean {
  switch (mascara) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}
