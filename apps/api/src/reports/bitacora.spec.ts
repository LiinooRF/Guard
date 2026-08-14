import { patrolRulesSchema } from '@voxia/shared';

import {
  construirBitacora,
  construirInformeRonda,
  redactarMotivoIncompleta,
  type EncabezadoRondaRow,
  type EntradaModelo,
  type FotoRow,
  type IncidenteRow,
  type PuntoEsperadoRow,
  type ScanRow,
  type TareaRow,
} from './patrol-report.model';
import type { MarcaDocumento } from './pdf-primitivas';

/**
 * El criterio de orden de la bitacora y el texto derivado del motivo (#308).
 *
 * Nada de esto importa pdfkit: el orden, el reparto de la evidencia y la
 * redaccion del motivo son funciones puras justamente para poder probarlas sin
 * abrir un PDF, que no dice nada util cuando se rompe.
 */

const UMBRAL = patrolRulesSchema.parse({}).complianceThreshold;

const MARCA: MarcaDocumento = {
  displayName: 'Seguridad Demo SpA',
  logoUri: null,
  primaryColor: '#1f3b73',
  mailFooter: null,
};

const RONDA: EncabezadoRondaRow = {
  id: 'patrol-id',
  status: 'completada',
  scheduled_start_at: new Date('2026-07-30T22:00:00-04:00'),
  scheduled_end_at: new Date('2026-07-31T06:00:00-04:00'),
  started_at: new Date('2026-07-30T22:05:00-04:00'),
  closed_at: new Date('2026-07-31T05:40:00-04:00'),
  compliance_pct: '100.00',
  site_id: 'site-1',
  site_name: 'Planta Norte',
  branch_name: 'Casa matriz',
  timezone: 'America/Santiago',
  route_name: 'Ronda nocturna',
  guard_name: 'Juan Soto',
};

const PUNTOS: PuntoEsperadoRow[] = [
  { position: '1', id: 'cp-1', name: 'Acceso principal', kind: 'normal', is_closing_point: false },
  { position: '2', id: 'cp-2', name: 'Bodega', kind: 'normal', is_closing_point: false },
  { position: '3', id: 'cp-3', name: 'Portería', kind: 'acceso_critico', is_closing_point: true },
];

const escaneo = (checkpointId: string, hora: string, extra: Partial<ScanRow> = {}): ScanRow => ({
  checkpoint_id: checkpointId,
  method: 'nfc',
  scanned_at_server: new Date(hora),
  scanned_at_device: null,
  anomalies: [],
  ...extra,
});

const foto = (id: string, checkpointId: string, extra: Partial<FotoRow> = {}): FotoRow => ({
  id,
  scan_id: `sc-${checkpointId}`,
  checkpoint_id: checkpointId,
  checkpoint_name: 'Portería',
  storage_path: `tenant/patrol/${id}.jpg`,
  mime_type: 'image/jpeg',
  size_bytes: '204800',
  sha256: 'a'.repeat(64),
  taken_at_device: null,
  created_at: new Date('2026-07-31T05:41:00-04:00'),
  ...extra,
});

const tarea = (parcial: Partial<TareaRow> = {}): TareaRow => ({
  item_id: 'it-1',
  position: 1,
  label: 'Fotografiar el refrigerador',
  response_type: 'ok_falla',
  requires_photo: false,
  requires_photo_on_fail: false,
  due_local_time: null,
  checkpoint_id: null,
  checkpoint_name: null,
  response_id: null,
  value: null,
  notes: null,
  failed: null,
  photo_id: null,
  late_minutes: null,
  responded_at: null,
  ...parcial,
});

const incidente = (parcial: Partial<IncidenteRow> = {}): IncidenteRow => ({
  id: 'ev-1',
  criticality: 'media',
  text: 'Luminaria del pasillo B quemada',
  reported_at_server: new Date('2026-07-31T01:00:00-04:00'),
  ...parcial,
});

const entrada = (parcial: Partial<EntradaModelo> = {}): EntradaModelo => ({
  ronda: RONDA,
  puntos: PUNTOS,
  scans: [],
  fotos: [],
  incidentes: [],
  marca: MARCA,
  umbral: UMBRAL,
  ...parcial,
});

const armar = (parcial: Partial<EntradaModelo> = {}) => construirInformeRonda(entrada(parcial));

describe('construirBitacora · orden', () => {
  it('mezcla escaneos, tareas y novedades en una sola cronología ascendente', () => {
    const informe = armar({
      scans: [
        escaneo('cp-1', '2026-07-30T22:10:00-04:00'),
        escaneo('cp-3', '2026-07-31T01:30:00-04:00'),
      ],
      tareas: [
        tarea({
          response_id: 'rs-1',
          value: 'ok',
          failed: false,
          responded_at: new Date('2026-07-31T00:40:00-04:00'),
        }),
      ],
      incidentes: [incidente()],
    });

    const bitacora = construirBitacora(informe);

    expect(bitacora.entradas.map((e) => e.tipo)).toEqual([
      'inicio',
      'escaneo',
      'tarea',
      'incidente',
      'escaneo',
      'cierre',
    ]);
    const instantes = bitacora.entradas.map((e) => e.instante.getTime());
    expect([...instantes].sort((a, b) => a - b)).toEqual(instantes);
  });

  it('el desempate es determinista: dos corridas dan exactamente lo mismo', () => {
    // Tres cosas en el mismo instante, que es lo normal cuando la cola offline
    // sube un lote entero de golpe.
    const mismoInstante = '2026-07-30T23:00:00-04:00';
    const construir = () =>
      construirBitacora(
        armar({
          scans: [
            escaneo('cp-3', mismoInstante),
            escaneo('cp-1', mismoInstante),
            escaneo('cp-2', mismoInstante),
          ],
          incidentes: [incidente({ reported_at_server: new Date(mismoInstante) })],
        }),
      );

    const primera = construir().entradas.map((e) => e.clave);
    const segunda = construir().entradas.map((e) => e.clave);

    expect(primera).toEqual(segunda);
    // El escaneo va antes que la novedad del mismo segundo, y entre escaneos
    // manda el numero de punto de la ruta.
    expect(primera).toEqual([
      'inicio',
      'escaneo:cp-1',
      'escaneo:cp-2',
      'escaneo:cp-3',
      'novedad:ev-1',
      'cierre',
    ]);
  });

  it('NO usa el reloj del teléfono para ordenar', () => {
    // taken_at_device de la foto esta adelantado ocho horas y no mueve nada: la
    // cronologia se arma con relojes de servidor y la foto cuelga de su escaneo.
    const informe = armar({
      scans: [escaneo('cp-1', '2026-07-30T22:10:00-04:00')],
      fotos: [foto('f1', 'cp-1', { taken_at_device: new Date('2026-07-31T06:00:00-04:00') })],
    });

    const bitacora = construirBitacora(informe);
    const escaneoEntrada = bitacora.entradas.find((e) => e.tipo === 'escaneo');

    expect(bitacora.entradas.map((e) => e.tipo)).toEqual(['inicio', 'escaneo', 'cierre']);
    expect(escaneoEntrada?.fotos.map((f) => f.id)).toEqual(['f1']);
  });

  it('una ronda no iniciada no tiene entrada de inicio', () => {
    const informe = armar({ ronda: { ...RONDA, started_at: null, closed_at: null } });
    expect(construirBitacora(informe).entradas).toEqual([]);
  });

  it('corta en el tope del tenant y dice cuántas quedaron fuera', () => {
    const informe = armar({
      scans: [
        escaneo('cp-1', '2026-07-30T22:10:00-04:00'),
        escaneo('cp-2', '2026-07-30T23:10:00-04:00'),
        escaneo('cp-3', '2026-07-31T00:10:00-04:00'),
      ],
    });

    // inicio + 3 escaneos + cierre = 5 entradas.
    const bitacora = construirBitacora(informe, { maxEntradas: 3 });

    expect(bitacora.entradas).toHaveLength(3);
    expect(bitacora.omitidasPorTope).toBe(2);
  });
});

describe('construirBitacora · reparto de la evidencia', () => {
  it('la foto que reclama una tarea cuelga de la tarea, no del escaneo', () => {
    const informe = armar({
      scans: [escaneo('cp-3', '2026-07-30T23:00:00-04:00')],
      fotos: [foto('f1', 'cp-3')],
      tareas: [
        tarea({
          response_id: 'rs-1',
          value: 'ok',
          failed: false,
          requires_photo: true,
          photo_id: 'f1',
          responded_at: new Date('2026-07-31T00:05:00-04:00'),
        }),
      ],
    });

    const bitacora = construirBitacora(informe);

    expect(bitacora.entradas.find((e) => e.tipo === 'tarea')?.fotos.map((f) => f.id)).toEqual([
      'f1',
    ]);
    expect(bitacora.entradas.find((e) => e.tipo === 'escaneo')?.fotos).toEqual([]);
  });

  it('la foto de un punto que no está en la ruta se conserva, no se descarta', () => {
    const informe = armar({
      scans: [escaneo('cp-1', '2026-07-30T23:00:00-04:00')],
      fotos: [foto('f1', 'cp-fuera', { checkpoint_name: 'Patio trasero' })],
    });

    const bitacora = construirBitacora(informe);

    expect(bitacora.evidenciaSinPunto.map((f) => f.id)).toEqual(['f1']);
    expect(bitacora.entradas.flatMap((e) => e.fotos)).toEqual([]);
  });

  it('cada foto tiene un solo dueño', () => {
    const informe = armar({
      scans: [escaneo('cp-3', '2026-07-30T23:00:00-04:00')],
      fotos: [foto('f1', 'cp-3'), foto('f2', 'cp-3', { sha256: 'b'.repeat(64) })],
      tareas: [
        tarea({
          response_id: 'rs-1',
          value: 'ok',
          failed: false,
          photo_id: 'f1',
          requires_photo: true,
          responded_at: new Date('2026-07-31T00:05:00-04:00'),
        }),
      ],
    });

    const bitacora = construirBitacora(informe);
    const colgadas = bitacora.entradas.flatMap((e) => e.fotos.map((f) => f.id));

    expect(colgadas.sort()).toEqual(['f1', 'f2']);
    expect(new Set(colgadas).size).toBe(colgadas.length);
    expect(bitacora.evidenciaSinPunto).toEqual([]);
  });
});

describe('construirBitacora · lo que no tiene hora', () => {
  it('la tarea sin responder no entra a la cronología y sí al bloque de cierre', () => {
    // Es el dato que mas le importa al supervisor y justamente el que no puede
    // estar en una linea de tiempo: nunca ocurrio. Inventarle la hora pedida
    // seria escribir en el informe algo que no sucedio.
    const informe = armar({ tareas: [tarea({ due_local_time: '11:00:00' })] });

    const bitacora = construirBitacora(informe);

    expect(bitacora.entradas.some((e) => e.tipo === 'tarea')).toBe(false);
    expect(bitacora.tareasSinResponder.map((t) => t.itemId)).toEqual(['it-1']);
  });

  it('ordena las tareas sin responder por hora pedida, con las sin hora al final', () => {
    const informe = armar({
      tareas: [
        tarea({ item_id: 'a', due_local_time: null }),
        tarea({ item_id: 'b', due_local_time: '23:00:00' }),
        tarea({ item_id: 'c', due_local_time: '02:00:00' }),
      ],
    });

    expect(construirBitacora(informe).tareasSinResponder.map((t) => t.itemId)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });

  it('sin checklist la bitácora no tiene ni una entrada de tarea ni bloque de cierre', () => {
    const informe = armar({ scans: [escaneo('cp-1', '2026-07-30T23:00:00-04:00')] });

    const bitacora = construirBitacora(informe);

    expect(bitacora.entradas.some((e) => e.tipo === 'tarea')).toBe(false);
    expect(bitacora.tareasSinResponder).toEqual([]);
  });
});

describe('redactarMotivoIncompleta', () => {
  it('una ronda completa y limpia no recibe ninguna viñeta', () => {
    const informe = armar({
      scans: PUNTOS.map((p) => escaneo(p.id, '2026-07-30T23:00:00-04:00')),
    });

    expect(redactarMotivoIncompleta(informe)).toEqual([]);
  });

  it('la ronda no iniciada dice solo eso', () => {
    const informe = armar({ ronda: { ...RONDA, started_at: null, closed_at: null } });

    // No se enumeran los tres puntos omitidos: no paso nada mas que reportar.
    expect(redactarMotivoIncompleta(informe)).toEqual(['Ronda no iniciada']);
  });

  it('nombra los puntos sin escanear y el punto de cierre', () => {
    const informe = armar({ scans: [escaneo('cp-1', '2026-07-30T23:00:00-04:00')] });

    const motivos = redactarMotivoIncompleta(informe).join(' | ');

    expect(motivos).toContain('2 punto(s) sin escanear de 3');
    expect(motivos).toContain('Bodega');
    expect(motivos).toContain('El punto de cierre no se escaneó');
  });

  it('menciona las marcas de anomalía y el desvío de turno', () => {
    const informe = armar({
      scans: [
        ...PUNTOS.map((p) => escaneo(p.id, '2026-07-30T23:00:00-04:00')),
        // Una cuarta lectura no cambia nada: manda la primera de cada punto.
        escaneo('cp-2', '2026-07-30T23:20:00-04:00', { anomalies: ['fuera_de_radio_gps'] }),
      ],
      ronda: { ...RONDA, scheduled_end_at: new Date('2026-07-30T22:30:00-04:00') },
    });

    const motivos = redactarMotivoIncompleta(informe).join(' | ');

    expect(motivos).toContain('marca(s) fuera del turno');
    expect(motivos).toContain('después del cierre del turno');
  });

  it('cuenta las tareas sin responder, con falla y sin la foto exigida', () => {
    const informe = armar({
      scans: PUNTOS.map((p) => escaneo(p.id, '2026-07-30T23:00:00-04:00')),
      tareas: [
        tarea({ item_id: 'a' }),
        tarea({
          item_id: 'b',
          response_id: 'rs-b',
          value: 'falla',
          failed: true,
          requires_photo: true,
          responded_at: new Date('2026-07-31T00:05:00-04:00'),
        }),
      ],
    });

    const motivos = redactarMotivoIncompleta(informe).join(' | ');

    expect(motivos).toContain('1 tarea(s) sin responder');
    expect(motivos).toContain('1 tarea(s) con falla');
    expect(motivos).toContain('1 tarea(s) sin la foto exigida');
  });

  it('una ronda sin checklist no gana ni una viñeta de tareas', () => {
    const informe = armar({ scans: [escaneo('cp-1', '2026-07-30T23:00:00-04:00')] });

    expect(redactarMotivoIncompleta(informe).join(' | ')).not.toContain('tarea');
  });

  it('avisa cuando la ronda quedó sin cierre registrado', () => {
    const informe = armar({
      scans: PUNTOS.map((p) => escaneo(p.id, '2026-07-30T23:00:00-04:00')),
      ronda: { ...RONDA, closed_at: null },
    });

    expect(redactarMotivoIncompleta(informe)).toContain('Ronda sin cierre registrado');
  });
});

describe('coherencia de cifras entre secciones', () => {
  it('los omitidos de la lista son exactamente los que declara el cumplimiento', () => {
    // Si la bitacora o la portada contaran por su cuenta, el porcentaje del
    // encabezado terminaria contradiciendo a la tabla de abajo.
    const informe = armar({ scans: [escaneo('cp-2', '2026-07-30T23:00:00-04:00')] });

    expect(informe.omitidos).toHaveLength(
      informe.compliance.expected - informe.compliance.scanned,
    );
    expect(informe.omitidos.map((p) => p.checkpointId)).toEqual(
      informe.compliance.missedCheckpointIds,
    );
  });
});
