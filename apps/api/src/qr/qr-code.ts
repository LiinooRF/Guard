/**
 * Codificador de codigos QR escrito a mano, sin dependencias. Ver issues #56 y
 * #135.
 *
 * Alcance a proposito estrecho: modo byte, nivel de correccion Q y versiones 1
 * a 10. Con eso entra de sobra el UID de una etiqueta (30 caracteres) y el
 * archivo se puede leer entero. Un payload mas grande lanza en vez de degradar
 * en silencio a algo que despues nadie escanea.
 *
 * Nivel Q (25% de recuperacion) porque estas etiquetas terminan pegadas en
 * porterias, bodegas y perimetros: se rayan, se ensucian y se despegan de una
 * esquina. Con nivel L el mismo dano deja el punto ilegible.
 *
 * Referencia: ISO/IEC 18004. Las tablas de abajo son las de la norma; el test
 * qr-code.spec.ts las verifica contra invariantes independientes (el conteo de
 * modulos de datos, los 32 valores de formato y los de version).
 */

export interface QrMatriz {
  readonly size: number;
  readonly modules: readonly (readonly boolean[])[];
}

export interface QrTramo {
  readonly x: number;
  readonly y: number;
  readonly largo: number;
}

/** Modulos en blanco alrededor del simbolo. Sin esto muchos lectores fallan. */
export const ZONA_QUIETA = 4;

const NIVEL_Q = 3;
const VERSION_MAX = 10;
const POLINOMIO_GF = 0x11d;

interface EspecVersion {
  /** Codewords totales del simbolo (datos + correccion). */
  readonly totalCodewords: number;
  readonly ecPorBloque: number;
  /** Grupos de bloques: [cantidad de bloques, codewords de datos por bloque]. */
  readonly bloques: readonly (readonly [number, number])[];
}

const ESPECS: readonly EspecVersion[] = [
  { totalCodewords: 26, ecPorBloque: 13, bloques: [[1, 13]] },
  { totalCodewords: 44, ecPorBloque: 22, bloques: [[1, 22]] },
  { totalCodewords: 70, ecPorBloque: 18, bloques: [[2, 17]] },
  { totalCodewords: 100, ecPorBloque: 26, bloques: [[2, 24]] },
  { totalCodewords: 134, ecPorBloque: 18, bloques: [[2, 15], [2, 16]] },
  { totalCodewords: 172, ecPorBloque: 24, bloques: [[4, 19]] },
  { totalCodewords: 196, ecPorBloque: 18, bloques: [[2, 14], [4, 15]] },
  { totalCodewords: 242, ecPorBloque: 22, bloques: [[4, 18], [2, 19]] },
  { totalCodewords: 292, ecPorBloque: 20, bloques: [[4, 16], [4, 17]] },
  { totalCodewords: 346, ecPorBloque: 24, bloques: [[6, 19], [2, 20]] },
];

const CENTROS_ALINEACION: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

// Los bits de resto de la norma (0 o 7 segun la version) no se declaran: la
// colocacion corta con `indice >= totalBits` y deja esos modulos en 0, que es
// justo lo que la norma especifica que valgan. Declararlos seria describir un
// relleno que ya ocurre solo.

// ------------------------------------------------------------------ GF(256)

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= POLINOMIO_GF;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255]!;
})();

function multiplicar(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** Polinomio generador de grado `grado`, coeficientes de mayor a menor. */
export function polinomioGenerador(grado: number): readonly number[] {
  let g: number[] = [1];
  for (let i = 0; i < grado; i += 1) {
    const siguiente = new Array<number>(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j += 1) {
      siguiente[j] = siguiente[j]! ^ g[j]!;
      siguiente[j + 1] = siguiente[j + 1]! ^ multiplicar(g[j]!, EXP[i]!);
    }
    g = siguiente;
  }
  return g;
}

/** Codewords de correccion Reed-Solomon de un bloque de datos. */
export function correccionReedSolomon(datos: readonly number[], grado: number): number[] {
  const generador = polinomioGenerador(grado);
  const resto = new Array<number>(grado).fill(0);
  for (const codeword of datos) {
    const factor = codeword ^ resto[0]!;
    resto.shift();
    resto.push(0);
    for (let i = 0; i < grado; i += 1) {
      resto[i] = resto[i]! ^ multiplicar(generador[i + 1]!, factor);
    }
  }
  return resto;
}

// ------------------------------------------------------- formato y version

/** 15 bits de informacion de formato (nivel Q + mascara) con su BCH. */
export function bitsFormato(mascara: number): number {
  const datos = (NIVEL_Q << 3) | mascara;
  let resto = datos;
  for (let i = 0; i < 10; i += 1) {
    resto = (resto << 1) ^ ((resto >>> 9) * 0x537);
  }
  return ((datos << 10) | resto) ^ 0x5412;
}

/** 18 bits de informacion de version, solo para versiones 7 y superiores. */
export function bitsVersion(version: number): number {
  let resto = version;
  for (let i = 0; i < 12; i += 1) {
    resto = (resto << 1) ^ ((resto >>> 11) * 0x1f25);
  }
  return (version << 12) | resto;
}

// ------------------------------------------------------------- codificacion

function aBytes(texto: string): number[] {
  const bytes: number[] = [];
  for (const caracter of texto) {
    const punto = caracter.codePointAt(0)!;
    if (punto > 0xff) {
      throw new Error('El contenido del QR debe ser texto de un byte por caracter');
    }
    bytes.push(punto);
  }
  return bytes;
}

function especDe(version: number): EspecVersion {
  return ESPECS[version - 1]!;
}

function codewordsDeDatos(espec: EspecVersion): number {
  return espec.bloques.reduce((suma, [cantidad, datos]) => suma + cantidad * datos, 0);
}

/** Bits del indicador de cantidad de caracteres en modo byte. */
function bitsContador(version: number): number {
  return version < 10 ? 8 : 16;
}

function versionParaLargo(largo: number): number {
  for (let version = 1; version <= VERSION_MAX; version += 1) {
    const capacidadBits = codewordsDeDatos(especDe(version)) * 8 - 4 - bitsContador(version);
    if (largo * 8 <= capacidadBits) return version;
  }
  throw new Error('El contenido excede la capacidad del QR soportado (version 10, nivel Q)');
}

function codewordsFinales(bytes: readonly number[], version: number): number[] {
  const espec = especDe(version);
  const totalDatos = codewordsDeDatos(espec);
  const bits: number[] = [];
  const empujar = (valor: number, cantidad: number) => {
    for (let i = cantidad - 1; i >= 0; i -= 1) bits.push((valor >>> i) & 1);
  };

  empujar(0b0100, 4);
  empujar(bytes.length, bitsContador(version));
  for (const byte of bytes) empujar(byte, 8);

  const capacidadBits = totalDatos * 8;
  empujar(0, Math.min(4, capacidadBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const datos: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j]!;
    datos.push(byte);
  }
  // Relleno alternado que exige la norma hasta completar el area de datos.
  for (let i = 0; datos.length < totalDatos; i += 1) datos.push(i % 2 === 0 ? 0xec : 0x11);

  const bloquesDatos: number[][] = [];
  const bloquesEc: number[][] = [];
  let offset = 0;
  for (const [cantidad, porBloque] of espec.bloques) {
    for (let i = 0; i < cantidad; i += 1) {
      const bloque = datos.slice(offset, offset + porBloque);
      offset += porBloque;
      bloquesDatos.push(bloque);
      bloquesEc.push(correccionReedSolomon(bloque, espec.ecPorBloque));
    }
  }

  // Intercalado: primero un codeword de cada bloque de datos, despues los de
  // correccion. Un rayon en la etiqueta se reparte entre bloques y ninguno se
  // pasa de su capacidad de recuperacion.
  const salida: number[] = [];
  const maxDatos = Math.max(...bloquesDatos.map((bloque) => bloque.length));
  for (let i = 0; i < maxDatos; i += 1) {
    for (const bloque of bloquesDatos) {
      if (i < bloque.length) salida.push(bloque[i]!);
    }
  }
  for (let i = 0; i < espec.ecPorBloque; i += 1) {
    for (const bloque of bloquesEc) salida.push(bloque[i]!);
  }
  return salida;
}

// ----------------------------------------------------------------- trazado

function crearMatriz(size: number): boolean[][] {
  return Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
}

function marcarFuncion(
  modulos: boolean[][],
  funcion: boolean[][],
  x: number,
  y: number,
  oscuro: boolean,
): void {
  const size = modulos.length;
  if (x < 0 || y < 0 || x >= size || y >= size) return;
  modulos[y]![x] = oscuro;
  funcion[y]![x] = true;
}

function bit(valor: number, indice: number): boolean {
  return ((valor >>> indice) & 1) !== 0;
}

function dibujarFormato(modulos: boolean[][], funcion: boolean[][], mascara: number): void {
  const size = modulos.length;
  const bits = bitsFormato(mascara);

  for (let i = 0; i <= 5; i += 1) marcarFuncion(modulos, funcion, 8, i, bit(bits, i));
  marcarFuncion(modulos, funcion, 8, 7, bit(bits, 6));
  marcarFuncion(modulos, funcion, 8, 8, bit(bits, 7));
  marcarFuncion(modulos, funcion, 7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i += 1) marcarFuncion(modulos, funcion, 14 - i, 8, bit(bits, i));

  for (let i = 0; i < 8; i += 1) marcarFuncion(modulos, funcion, size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i += 1) marcarFuncion(modulos, funcion, 8, size - 15 + i, bit(bits, i));

  // Modulo siempre oscuro: la norma lo fija aca y los lectores lo asumen.
  marcarFuncion(modulos, funcion, 8, size - 8, true);
}

function dibujarPatronesFijos(
  modulos: boolean[][],
  funcion: boolean[][],
  version: number,
): void {
  const size = modulos.length;

  for (let i = 0; i < size; i += 1) {
    marcarFuncion(modulos, funcion, 6, i, i % 2 === 0);
    marcarFuncion(modulos, funcion, i, 6, i % 2 === 0);
  }

  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const distancia = Math.max(Math.abs(dx), Math.abs(dy));
        marcarFuncion(modulos, funcion, cx + dx, cy + dy, distancia !== 2 && distancia !== 4);
      }
    }
  }

  const centros = CENTROS_ALINEACION[version - 1]!;
  for (let i = 0; i < centros.length; i += 1) {
    for (let j = 0; j < centros.length; j += 1) {
      const esquinaDeFinder =
        (i === 0 && j === 0) ||
        (i === 0 && j === centros.length - 1) ||
        (i === centros.length - 1 && j === 0);
      if (esquinaDeFinder) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const distancia = Math.max(Math.abs(dx), Math.abs(dy));
          marcarFuncion(modulos, funcion, centros[j]! + dx, centros[i]! + dy, distancia !== 1);
        }
      }
    }
  }

  if (version >= 7) {
    const bits = bitsVersion(version);
    for (let i = 0; i < 18; i += 1) {
      const valor = bit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      marcarFuncion(modulos, funcion, a, b, valor);
      marcarFuncion(modulos, funcion, b, a, valor);
    }
  }

  // Reserva el area de formato para que el trazado de datos no la pise; los
  // bits definitivos se escriben al elegir la mascara.
  dibujarFormato(modulos, funcion, 0);
}

function dibujarDatos(
  modulos: boolean[][],
  funcion: boolean[][],
  codewords: readonly number[],
): void {
  const size = modulos.length;
  let indice = 0;
  const totalBits = codewords.length * 8;

  for (let derecha = size - 1; derecha >= 1; derecha -= 2) {
    if (derecha === 6) derecha = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = derecha - j;
        const subiendo = ((derecha + 1) & 2) === 0;
        const y = subiendo ? size - 1 - vertical : vertical;
        if (funcion[y]![x] || indice >= totalBits) continue;
        modulos[y]![x] = bit(codewords[indice >>> 3]!, 7 - (indice & 7));
        indice += 1;
      }
    }
  }
}

function condicionMascara(mascara: number, x: number, y: number): boolean {
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

function aplicarMascara(modulos: boolean[][], funcion: boolean[][], mascara: number): void {
  const size = modulos.length;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (funcion[y]![x]) continue;
      modulos[y]![x] = modulos[y]![x] !== condicionMascara(mascara, x, y);
    }
  }
}

const PATRON_FALSO_FINDER: readonly boolean[] = [
  true, false, true, true, true, false, true, false, false, false, false,
].map(Boolean);

function penalidadRacha(linea: readonly boolean[]): number {
  let total = 0;
  let largo = 1;
  for (let i = 1; i < linea.length; i += 1) {
    if (linea[i] === linea[i - 1]) {
      largo += 1;
      continue;
    }
    if (largo >= 5) total += 3 + (largo - 5);
    largo = 1;
  }
  if (largo >= 5) total += 3 + (largo - 5);
  return total;
}

function contarFalsosFinders(linea: readonly boolean[]): number {
  let total = 0;
  for (let i = 0; i + 11 <= linea.length; i += 1) {
    let adelante = true;
    let atras = true;
    for (let j = 0; j < 11; j += 1) {
      if (linea[i + j] !== PATRON_FALSO_FINDER[j]) adelante = false;
      if (linea[i + j] !== PATRON_FALSO_FINDER[10 - j]) atras = false;
    }
    if (adelante) total += 1;
    if (atras) total += 1;
  }
  return total;
}

/** Penalidad de la norma: cuanto menos, mas facil de leer. */
export function penalidad(modulos: readonly (readonly boolean[])[]): number {
  const size = modulos.length;
  let total = 0;
  let oscuros = 0;

  for (let i = 0; i < size; i += 1) {
    const fila = modulos[i]!;
    const columna = modulos.map((f) => f[i]!);
    total += penalidadRacha(fila) + penalidadRacha(columna);
    total += 40 * (contarFalsosFinders(fila) + contarFalsosFinders(columna));
    for (const modulo of fila) if (modulo) oscuros += 1;
  }

  for (let y = 0; y + 1 < size; y += 1) {
    for (let x = 0; x + 1 < size; x += 1) {
      const color = modulos[y]![x];
      if (
        color === modulos[y]![x + 1] &&
        color === modulos[y + 1]![x] &&
        color === modulos[y + 1]![x + 1]
      ) {
        total += 3;
      }
    }
  }

  const porcentaje = (oscuros * 100) / (size * size);
  total += 10 * Math.floor(Math.abs(porcentaje - 50) / 5);
  return total;
}

/** Matriz de modulos del QR. `modules[y][x] === true` es un modulo oscuro. */
export function qrMatriz(texto: string): QrMatriz {
  const bytes = aBytes(texto);
  const version = versionParaLargo(bytes.length);
  const codewords = codewordsFinales(bytes, version);
  const size = 4 * version + 17;
  const modulos = crearMatriz(size);
  const funcion = crearMatriz(size);

  dibujarPatronesFijos(modulos, funcion, version);
  dibujarDatos(modulos, funcion, codewords);

  let mejor = 0;
  let mejorPenalidad = Number.POSITIVE_INFINITY;
  for (let mascara = 0; mascara < 8; mascara += 1) {
    aplicarMascara(modulos, funcion, mascara);
    dibujarFormato(modulos, funcion, mascara);
    const puntaje = penalidad(modulos);
    if (puntaje < mejorPenalidad) {
      mejorPenalidad = puntaje;
      mejor = mascara;
    }
    aplicarMascara(modulos, funcion, mascara);
  }
  aplicarMascara(modulos, funcion, mejor);
  dibujarFormato(modulos, funcion, mejor);

  return { size, modules: modulos };
}

/** Modulos oscuros agrupados en tramos horizontales, con la zona quieta ya sumada. */
export function qrTramos(matriz: QrMatriz): QrTramo[] {
  const tramos: QrTramo[] = [];
  for (let y = 0; y < matriz.size; y += 1) {
    const fila = matriz.modules[y]!;
    let x = 0;
    while (x < matriz.size) {
      if (!fila[x]) {
        x += 1;
        continue;
      }
      let largo = 1;
      while (x + largo < matriz.size && fila[x + largo]) largo += 1;
      tramos.push({ x: x + ZONA_QUIETA, y: y + ZONA_QUIETA, largo });
      x += largo;
    }
  }
  return tramos;
}

/**
 * SVG autocontenido, en unidades de modulo. Lo consume el panel para mostrar y
 * mandar a imprimir una etiqueta suelta sin pedir el PDF completo.
 */
export function qrSvg(texto: string, moduloPx = 4): string {
  const matriz = qrMatriz(texto);
  const lado = matriz.size + ZONA_QUIETA * 2;
  const trazo = qrTramos(matriz)
    .map(({ x, y, largo }) => `M${x} ${y}h${largo}v1h-${largo}z`)
    .join('');
  const px = lado * moduloPx;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" ` +
    `viewBox="0 0 ${lado} ${lado}" shape-rendering="crispEdges">` +
    `<rect width="${lado}" height="${lado}" fill="#ffffff"/>` +
    `<path fill="#000000" d="${trazo}"/>` +
    '</svg>'
  );
}
