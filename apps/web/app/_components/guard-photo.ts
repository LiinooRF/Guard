'use client';

/**
 * Procesamiento de la foto de evidencia antes de encolarla (#67).
 *
 * Dos cosas que la evidencia necesita y que el `File` crudo de la cámara no
 * trae:
 *
 *  1. **Pesar poco.** El guardia sube con red móvil pobre desde un subterráneo.
 *     Una foto de 4 MB no sube; una de 300 KB sí. Se reescala el lado largo y se
 *     recomprime a JPEG bajando la calidad hasta entrar bajo el objetivo.
 *
 *  2. **Marca de agua quemada en los píxeles.** El fraude conocido del rubro es
 *     fotografiar la puerta cerrada una vez y reusar esa imagen todo el mes. La
 *     fecha y hora impresas ENCIMA de la imagen lo delatan: una foto reusada
 *     muestra un timestamp que no cuadra. Va en los píxeles, no en metadatos,
 *     porque los metadatos se editan y no se ven al abrir el archivo.
 *
 * La captura desde galería se bloquea aguas arriba: el shell nativo no declara
 * permiso de galería (ver `apps/mobile`), así que el selector del WebView solo
 * ofrece la cámara. Este módulo asume que lo que recibe ya es una captura en
 * vivo; su trabajo es dejarla liviana y trazable.
 *
 * La lógica pura (dimensiones, texto de la marca) se prueba en Jest. El dibujo
 * en canvas depende del navegador y por eso `procesarFoto` degrada con gracia:
 * si no hay canvas o algo falla, devuelve el archivo original antes que perder
 * la evidencia.
 */

/** Objetivo de tamaño: por debajo sube bien con red móvil pobre. */
export const TAMANO_OBJETIVO_BYTES = 500 * 1024;

/** Lado más largo tras reescalar. 1600 px basta para leer el estado de una puerta. */
export const LADO_MAXIMO = 1600;

/**
 * Escalones de calidad JPEG que se prueban en orden hasta entrar bajo el
 * objetivo. Se empieza alto para no degradar de más una foto que ya era liviana.
 */
export const CALIDADES_JPEG: readonly number[] = [0.82, 0.7, 0.6, 0.5, 0.42];

/** Calidad mínima aceptable: por debajo la foto deja de servir como evidencia. */
export const CALIDAD_MINIMA = CALIDADES_JPEG[CALIDADES_JPEG.length - 1] as number;

/**
 * Nuevas dimensiones preservando la proporción, reescalando SOLO hacia abajo.
 * Una foto que ya cabe en `ladoMax` no se toca: agrandarla suma peso sin sumar
 * detalle.
 */
export function calcularDimensiones({
  ancho,
  alto,
  ladoMax = LADO_MAXIMO,
}: {
  ancho: number;
  alto: number;
  ladoMax?: number;
}): { ancho: number; alto: number } {
  const ladoLargo = Math.max(ancho, alto);
  if (ladoLargo <= ladoMax || ladoLargo === 0) return { ancho, alto };
  const factor = ladoMax / ladoLargo;
  return {
    ancho: Math.max(1, Math.round(ancho * factor)),
    alto: Math.max(1, Math.round(alto * factor)),
  };
}

/**
 * Líneas de la marca de agua, de la más a la menos importante. Se descartan las
 * vacías para no dibujar un renglón en blanco cuando falta un dato.
 *
 * La fecha y hora es la línea que importa: es la que delata una foto reusada.
 * `guardia` es opcional porque la identidad ya queda ligada del lado del
 * servidor a la subida autenticada; se imprime si el portal la tiene a mano.
 */
export function lineasMarcaAgua({
  fechaHora,
  sitio,
  ruta,
  guardia,
}: {
  fechaHora: string;
  sitio?: string;
  ruta?: string;
  guardia?: string;
}): string[] {
  const ubicacion = [sitio, ruta].filter((parte) => parte && parte.trim()).join(' · ');
  return [fechaHora, ubicacion, guardia?.trim() ?? '']
    .map((linea) => linea.trim())
    .filter((linea) => linea.length > 0);
}

/**
 * Fecha y hora del dispositivo formateada para la marca de agua. Hora de Chile,
 * 24 h, con fecha: el timestamp tiene que ser inequívoco cuando la foto termina
 * en un juicio laboral.
 */
export function fechaHoraMarca(fecha: Date = new Date()): string {
  return new Intl.DateTimeFormat('es-CL', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'America/Santiago',
  }).format(fecha);
}

export interface OpcionesFoto {
  sitio?: string;
  ruta?: string;
  guardia?: string;
  /** Inyectable para las pruebas; por defecto, la hora del dispositivo. */
  fecha?: Date;
  ladoMax?: number;
  objetivoBytes?: number;
}

// --------------------------------------------------------------- navegador

function haySoporteCanvas(): boolean {
  return typeof document !== 'undefined' && typeof HTMLCanvasElement !== 'undefined';
}

async function decodificar(file: File): Promise<{ bitmap: ImageBitmap; ancho: number; alto: number }> {
  // `imageOrientation: 'from-image'` respeta el EXIF del teléfono: sin esto, una
  // foto tomada en vertical se guarda acostada.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  return { bitmap, ancho: bitmap.width, alto: bitmap.height };
}

function dibujarMarcaAgua(ctx: CanvasRenderingContext2D, ancho: number, alto: number, lineas: string[]): void {
  if (!lineas.length) return;

  // El texto escala con el ancho para leerse igual en cualquier resolución.
  const fuente = Math.max(14, Math.round(ancho * 0.028));
  const margen = Math.round(fuente * 0.6);
  const altoLinea = Math.round(fuente * 1.35);
  const altoBanda = altoLinea * lineas.length + margen;

  ctx.save();
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(0, alto - altoBanda, ancho, altoBanda);

  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${fuente}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.8)';
  ctx.shadowBlur = Math.max(1, Math.round(fuente * 0.12));

  lineas.forEach((linea, indice) => {
    const y = alto - altoBanda + margen / 2 + altoLinea * indice + altoLinea / 2;
    ctx.fillText(linea, margen, y);
  });
  ctx.restore();
}

function aBlob(canvas: HTMLCanvasElement, calidad: number): Promise<Blob | null> {
  return new Promise((resolver) => canvas.toBlob(resolver, 'image/jpeg', calidad));
}

function nombreJpeg(original: string): string {
  const base = original.replace(/\.[^.]+$/, '');
  return `${base || 'evidencia'}.jpg`;
}

/**
 * Reescala, pone la marca de agua y comprime la foto a JPEG bajo el objetivo de
 * tamaño. Si el navegador no puede procesarla, devuelve el archivo original: en
 * terreno vale más una foto pesada que ninguna foto.
 */
export async function procesarFoto(file: File, opciones: OpcionesFoto = {}): Promise<File> {
  if (!haySoporteCanvas() || typeof createImageBitmap !== 'function') return file;

  const objetivo = opciones.objetivoBytes ?? TAMANO_OBJETIVO_BYTES;
  const lineas = lineasMarcaAgua({
    fechaHora: fechaHoraMarca(opciones.fecha),
    ...(opciones.sitio ? { sitio: opciones.sitio } : {}),
    ...(opciones.ruta ? { ruta: opciones.ruta } : {}),
    ...(opciones.guardia ? { guardia: opciones.guardia } : {}),
  });

  try {
    const { bitmap, ancho, alto } = await decodificar(file);
    const destino = calcularDimensiones({ ancho, alto, ladoMax: opciones.ladoMax ?? LADO_MAXIMO });

    const canvas = document.createElement('canvas');
    canvas.width = destino.ancho;
    canvas.height = destino.alto;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;

    ctx.drawImage(bitmap, 0, 0, destino.ancho, destino.alto);
    bitmap.close?.();
    dibujarMarcaAgua(ctx, destino.ancho, destino.alto, lineas);

    // Se prueban las calidades en orden y se guarda el último blob válido: si
    // ninguno entra bajo el objetivo, se sube el más liviano que se logró antes
    // que dejar al guardia sin registrar la novedad.
    let mejor: Blob | null = null;
    for (const calidad of CALIDADES_JPEG) {
      const blob = await aBlob(canvas, calidad);
      if (!blob) continue;
      mejor = blob;
      if (blob.size <= objetivo) break;
    }
    if (!mejor) return file;

    return new File([mejor], nombreJpeg(file.name), {
      type: 'image/jpeg',
      lastModified: Date.now(),
    });
  } catch {
    // Formato que el navegador no decodifica, memoria insuficiente en un equipo
    // de gama baja, etc. La novedad importa más que optimizar su foto.
    return file;
  }
}
