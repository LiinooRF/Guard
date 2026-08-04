import {
  construirLibroExcel,
  desfaseEnMinutos,
  horaLocalIso,
  textoAnomalias,
  type DatosExportacion,
  type EscaneoExcelRow,
  type NovedadExcelRow,
  type RondaExcelRow,
} from './excel-export.model';

/** Composicion pura: sin base de datos y sin Nest, como el modelo del PDF. */

const RONDA: RondaExcelRow = {
  id: '11111111-1111-1111-1111-111111111111',
  fecha_local: '2026-07-06',
  inicio_programado_local: '2026-07-06T22:00:00',
  fin_programado_local: '2026-07-07T06:00:00',
  inicio_real_local: '2026-07-06T22:04:11',
  cierre_local: '2026-07-07T05:31:02',
  site_name: 'Planta Norte',
  branch_name: 'Casa matriz',
  timezone: 'America/Santiago',
  route_name: 'Ronda nocturna',
  guard_name: 'Juan Soto',
  status: 'completada',
  compliance_pct: '90.00',
  is_voluntary: false,
  puntos_esperados: 12,
  puntos_marcados: '11',
  novedades: '1',
};

const ESCANEO: EscaneoExcelRow = {
  id: '33333333-3333-3333-3333-333333333333',
  patrol_id: RONDA.id,
  registrado_local: '2026-07-06T22:07:40',
  dispositivo_local: '2026-07-06T22:07:38',
  site_name: 'Planta Norte',
  branch_name: 'Casa matriz',
  timezone: 'America/Santiago',
  checkpoint_name: 'Acceso principal',
  kind: 'acceso_critico',
  method: 'nfc',
  guard_name: 'Juan Soto',
  fotos: '2',
  anomalies: ['fuera_de_radio_gps'],
  clock_offset_ms: null,
};

const NOVEDAD: NovedadExcelRow = {
  id: '44444444-4444-4444-4444-444444444444',
  registrado_local: '2026-07-06T23:41:12',
  dispositivo_local: null,
  site_name: 'Planta Norte',
  branch_name: 'Casa matriz',
  timezone: 'America/Santiago',
  criticality: 'alta',
  text: 'Portón lateral forzado',
  guard_name: 'Juan Soto',
  patrol_id: RONDA.id,
  corrects_event_id: null,
  fotos: '1',
};

const datos = (extra: Partial<DatosExportacion> = {}): DatosExportacion => ({
  empresa: 'Seguridad Demo SpA',
  desde: '2026-07-01',
  hasta: '2026-07-31',
  filtros: { recinto: null, sucursal: null, guardia: null },
  generadoEnLocal: '2026-08-03T09:15:00',
  zonaReferencia: 'America/Santiago',
  rondas: [RONDA],
  escaneos: [ESCANEO],
  novedades: [NOVEDAD],
  tope: 50_000,
  truncadas: [],
  ...extra,
});

describe('construirLibroExcel', () => {
  it('arma las cuatro hojas del informe', () => {
    const hojas = construirLibroExcel(datos());
    expect(hojas.map((hoja) => hoja.nombre)).toEqual([
      'Resumen',
      'Rondas',
      'Escaneos',
      'Novedades',
    ]);
  });

  it('deja las fechas como celdas de fecha, no como texto', () => {
    const [, rondas] = construirLibroExcel(datos());
    const fila = rondas!.filas[0]!;
    expect(fila[1]).toEqual({ tipo: 'fecha', valor: '2026-07-06' });
    expect(fila[2]).toEqual({ tipo: 'fechaHora', valor: '2026-07-06T22:00:00' });
    expect(fila[5]).toEqual({ tipo: 'fechaHora', valor: '2026-07-07T05:31:02' });
  });

  it('lleva la zona horaria del recinto en cada hoja de datos', () => {
    const [, rondas, escaneos, novedades] = construirLibroExcel(datos());
    for (const hoja of [rondas!, escaneos!, novedades!]) {
      const columna = hoja.columnas.findIndex((col) => col.titulo === 'Zona horaria');
      expect(columna).toBeGreaterThanOrEqual(0);
      expect(hoja.filas[0]![columna]).toEqual({ tipo: 'texto', valor: 'America/Santiago' });
    }
  });

  it('traduce estados, tipos de punto, metodos y criticidades', () => {
    const [, rondas, escaneos, novedades] = construirLibroExcel(datos());
    expect(rondas!.filas[0]![11]).toEqual({ tipo: 'texto', valor: 'Completada' });
    expect(escaneos!.filas[0]![8]).toEqual({ tipo: 'texto', valor: 'Acceso crítico' });
    expect(escaneos!.filas[0]![9]).toEqual({ tipo: 'texto', valor: 'NFC' });
    expect(novedades!.filas[0]![6]).toEqual({ tipo: 'texto', valor: 'Alta' });
  });

  it('no exporta coordenadas de los trabajadores en ninguna hoja', () => {
    // La planilla circula por correo. La desviacion de ubicacion se informa
    // como marca de anomalia; donde estuvo la persona, no.
    const titulos = construirLibroExcel(datos())
      .flatMap((hoja) => hoja.columnas.map((col) => col.titulo.toLowerCase()));
    for (const prohibido of ['latitud', 'longitud', 'coordenada', 'gps', 'ubicaci']) {
      expect(titulos.some((titulo) => titulo.includes(prohibido))).toBe(false);
    }
  });

  it('avisa en la portada cuando la exportacion quedo cortada', () => {
    const [resumen] = construirLibroExcel(datos({ truncadas: ['Escaneos'], tope: 100 }));
    const texto = JSON.stringify(resumen!.filas);
    expect(texto).toContain('ATENCIÓN');
    expect(texto).toContain('Escaneos');
    expect(texto).toContain('100');
  });

  it('cuando la hoja cortada es Rondas, avisa que el cruce entre hojas se rompio', () => {
    // Cada hoja tiene su propio LIMIT y su propio ORDER BY. Con Rondas cortada,
    // «Ronda (ID)» de Escaneos y Novedades apunta a filas que no estan en la
    // hoja Rondas: el BUSCARV da #N/D y hay que poder distinguir corte de dato
    // faltante.
    const [resumen] = construirLibroExcel(datos({ truncadas: ['Rondas'], tope: 100 }));
    const texto = JSON.stringify(resumen!.filas);
    expect(texto).toContain('BUSCARV');
    expect(texto).toContain('Ronda (ID)');
  });

  it('si el corte no toca Rondas, no inventa un aviso de cruce roto', () => {
    // Escaneos cortada no rompe el cruce: las rondas siguen todas ahi.
    const [resumen] = construirLibroExcel(datos({ truncadas: ['Escaneos'], tope: 100 }));
    expect(JSON.stringify(resumen!.filas)).not.toContain('BUSCARV');
  });

  it('sin filtros la portada dice Todos y no deja el campo en blanco', () => {
    const [resumen] = construirLibroExcel(datos());
    const filas = JSON.stringify(resumen!.filas);
    expect(filas).toContain('Todos');
    expect(filas).toContain('Seguridad Demo SpA');
  });

  it('la portada escribe el periodo como fechas', () => {
    const [resumen] = construirLibroExcel(datos());
    expect(resumen!.filas[2]![1]).toEqual({ tipo: 'fecha', valor: '2026-07-01' });
    expect(resumen!.filas[3]![1]).toEqual({ tipo: 'fecha', valor: '2026-07-31' });
  });

  it('todas las filas tienen tantas celdas como columnas', () => {
    for (const hoja of construirLibroExcel(datos()).slice(1)) {
      for (const fila of hoja.filas) {
        expect(fila).toHaveLength(hoja.columnas.length);
      }
    }
  });
});

describe('textoAnomalias', () => {
  it('lista las marcas en texto legible', () => {
    expect(textoAnomalias(['fuera_de_radio_gps', 'reloj_desfasado'])).toBe(
      'fuera de radio gps, reloj desfasado',
    );
  });

  it('tolera un jsonb que no sea arreglo sin romper la planilla', () => {
    expect(textoAnomalias(null)).toBe('');
    expect(textoAnomalias('[]')).toBe('');
    expect(textoAnomalias([1, 'sin_fix_gps'])).toBe('sin fix gps');
  });
});

describe('desfaseEnMinutos', () => {
  it('deja la celda vacia cuando no hay medicion', () => {
    // NULL significa "hora del dispositivo utilizable", no desfase cero:
    // escribir 0 afirmaria una medicion que nunca se hizo.
    expect(desfaseEnMinutos(null)).toEqual({ tipo: 'vacio' });
  });

  it('convierte milisegundos a minutos con un decimal', () => {
    expect(desfaseEnMinutos('420000')).toEqual({ tipo: 'numero', valor: 7, estilo: 5 });
    expect(desfaseEnMinutos(-90_000)).toEqual({ tipo: 'numero', valor: -1.5, estilo: 5 });
  });
});

describe('horaLocalIso', () => {
  it('convierte a la hora de pared del recinto', () => {
    expect(horaLocalIso(new Date('2026-07-07T02:00:00Z'), 'America/Santiago')).toBe(
      '2026-07-06T22:00:00',
    );
  });

  it('usa el reloj de 24 horas: la medianoche no se corre de dia', () => {
    expect(horaLocalIso(new Date('2026-07-07T03:00:00Z'), 'America/Santiago')).toBe(
      '2026-07-06T23:00:00',
    );
    expect(horaLocalIso(new Date('2026-07-07T04:00:00Z'), 'America/Santiago')).toBe(
      '2026-07-07T00:00:00',
    );
  });

  it('respeta la zona de cada recinto y no la del servidor', () => {
    const instante = new Date('2026-07-07T02:00:00Z');
    expect(horaLocalIso(instante, 'America/Santiago')).toBe('2026-07-06T22:00:00');
    expect(horaLocalIso(instante, 'Pacific/Easter')).toBe('2026-07-06T20:00:00');
  });

  it('no se cae con una zona invalida guardada en el recinto', () => {
    expect(horaLocalIso(new Date('2026-07-07T02:00:00Z'), 'Marte/Olympus')).toBe(
      '2026-07-07T02:00:00',
    );
  });
});
