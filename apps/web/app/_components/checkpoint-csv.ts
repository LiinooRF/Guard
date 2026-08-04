export interface CsvCheckpoint {
  name: string;
  description?: string;
  kind?: 'normal' | 'acceso_critico';
  suggestedOrder?: number;
  latitude?: number;
  longitude?: number;
  requiresPhoto?: boolean;
  instructions?: string;
  tagUid?: string;
}

export interface CsvResult {
  checkpoints: CsvCheckpoint[];
  errors: string[];
}

const HEADERS: Record<string, keyof CsvCheckpoint> = {
  nombre: 'name',
  name: 'name',
  descripcion: 'description',
  description: 'description',
  criticidad: 'kind',
  tipo: 'kind',
  kind: 'kind',
  orden: 'suggestedOrder',
  suggestedorder: 'suggestedOrder',
  latitud: 'latitude',
  latitude: 'latitude',
  longitud: 'longitude',
  longitude: 'longitude',
  foto_obligatoria: 'requiresPhoto',
  requiresphoto: 'requiresPhoto',
  instrucciones: 'instructions',
  instructions: 'instructions',
  uid_nfc: 'tagUid',
  taguid: 'tagUid',
};

/** CSV real: soporta comillas, separador coma/punto y coma y saltos dentro de comillas. */
export function parseCheckpointCsv(source: string): CsvResult {
  const clean = source.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(clean);
  const rows = splitCsv(clean, delimiter).filter((row) => row.some((cell) => cell.trim()));
  if (!rows.length) return { checkpoints: [], errors: ['El archivo está vacío.'] };

  const rawHeaders = rows[0]!.map(normalizeHeader);
  const headers = rawHeaders.map((header) => HEADERS[header]);
  if (!headers.includes('name')) {
    return { checkpoints: [], errors: ['Falta la columna obligatoria «nombre».'] };
  }

  const checkpoints: CsvCheckpoint[] = [];
  const errors: string[] = [];
  for (const [index, cells] of rows.slice(1).entries()) {
    const line = index + 2;
    const raw: Partial<Record<keyof CsvCheckpoint, string>> = {};
    headers.forEach((header, column) => {
      if (header) raw[header] = cells[column]?.trim() ?? '';
    });
    const name = raw.name?.trim();
    if (!name) {
      errors.push(`Fila ${line}: falta el nombre.`);
      continue;
    }
    const latitude = numberValue(raw.latitude, -90, 90, line, 'latitud', errors);
    const longitude = numberValue(raw.longitude, -180, 180, line, 'longitud', errors);
    const suggestedOrder = integerValue(raw.suggestedOrder, line, errors);
    const kind = parseKind(raw.kind, line, errors);
    const requiresPhoto = parseBoolean(raw.requiresPhoto, line, errors);
    if (errors.some((error) => error.startsWith(`Fila ${line}:`))) continue;

    checkpoints.push(compact({
      name,
      description: raw.description || undefined,
      kind,
      suggestedOrder,
      latitude,
      longitude,
      requiresPhoto,
      instructions: raw.instructions || undefined,
      tagUid: raw.tagUid || undefined,
    }));
  }
  return { checkpoints, errors };
}

export const CHECKPOINT_CSV_TEMPLATE = [
  'nombre;descripcion;criticidad;orden;latitud;longitud;foto_obligatoria;instrucciones;uid_nfc',
  'Portería;Acceso principal;acceso_critico;1;-33.448900;-70.669300;;Revisar cierre;04A1B2C3D4',
  'Patio norte;;normal;2;-33.448500;-70.669000;no;Revisar iluminación;',
].join('\n');

function detectDelimiter(source: string): ',' | ';' {
  const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
  return countOutsideQuotes(firstLine, ';') >= countOutsideQuotes(firstLine, ',') ? ';' : ',';
}

function countOutsideQuotes(value: string, target: string): number {
  let quoted = false;
  let count = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '"') quoted = !quoted;
    else if (!quoted && value[i] === target) count += 1;
  }
  return count;
}

function splitCsv(source: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function normalizeHeader(value: string): string {
  return value.trim().toLocaleLowerCase('es').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s-]+/g, '_');
}

function numberValue(
  value: string | undefined,
  min: number,
  max: number,
  line: number,
  label: string,
  errors: string[],
): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value.replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    errors.push(`Fila ${line}: ${label} inválida.`);
    return undefined;
  }
  return parsed;
}

function integerValue(value: string | undefined, line: number, errors: string[]): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    errors.push(`Fila ${line}: el orden debe ser un entero positivo.`);
    return undefined;
  }
  return parsed;
}

function parseKind(
  value: string | undefined,
  line: number,
  errors: string[],
): CsvCheckpoint['kind'] {
  if (!value) return undefined;
  const normalized = normalizeHeader(value);
  if (normalized === 'normal') return 'normal';
  if (normalized === 'acceso_critico' || normalized === 'critico') return 'acceso_critico';
  errors.push(`Fila ${line}: criticidad debe ser «normal» o «acceso_critico».`);
  return undefined;
}

function parseBoolean(value: string | undefined, line: number, errors: string[]): boolean | undefined {
  if (!value) return undefined;
  const normalized = normalizeHeader(value);
  if (['si', 'true', '1'].includes(normalized)) return true;
  if (['no', 'false', '0'].includes(normalized)) return false;
  errors.push(`Fila ${line}: foto_obligatoria debe ser «sí» o «no».`);
  return undefined;
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
