import { CHECKPOINT_CSV_TEMPLATE, parseCheckpointCsv } from './checkpoint-csv';

describe('CSV de puntos de control', () => {
  it('lee la plantilla oficial con criticidad, coordenadas, foto y NFC', () => {
    const result = parseCheckpointCsv(CHECKPOINT_CSV_TEMPLATE);
    expect(result.errors).toEqual([]);
    expect(result.checkpoints).toHaveLength(2);
    expect(result.checkpoints[0]).toMatchObject({
      name: 'Portería',
      kind: 'acceso_critico',
      latitude: -33.4489,
      longitude: -70.6693,
      tagUid: '04A1B2C3D4',
    });
    expect(result.checkpoints[1]?.requiresPhoto).toBe(false);
  });

  it('carga 30 puntos en una sola lectura', () => {
    const rows = Array.from({ length: 30 }, (_, index) =>
      `Punto ${index + 1};normal;${index + 1};-33.44;-70.66`,
    );
    const result = parseCheckpointCsv(
      ['nombre;criticidad;orden;latitud;longitud', ...rows].join('\n'),
    );
    expect(result.errors).toEqual([]);
    expect(result.checkpoints).toHaveLength(30);
    expect(result.checkpoints[29]?.suggestedOrder).toBe(30);
  });

  it('soporta comas, comillas y separadores dentro del texto', () => {
    const result = parseCheckpointCsv(
      'nombre,descripcion,criticidad\n"Portería, norte","Puerta ""principal""",acceso_critico',
    );
    expect(result.errors).toEqual([]);
    expect(result.checkpoints[0]).toMatchObject({
      name: 'Portería, norte',
      description: 'Puerta "principal"',
    });
  });

  it('informa todas las filas inválidas sin importar parcialmente', () => {
    const result = parseCheckpointCsv(
      'nombre;criticidad;latitud;foto_obligatoria\n;normal;-33;si\nPatio;desconocido;200;quizas',
    );
    expect(result.checkpoints).toEqual([]);
    expect(result.errors.join(' ')).toContain('Fila 2');
    expect(result.errors.join(' ')).toContain('Fila 3');
  });

  it('exige una columna nombre reconocible', () => {
    expect(parseCheckpointCsv('punto;tipo\nA;normal').errors[0]).toContain('nombre');
  });
});
