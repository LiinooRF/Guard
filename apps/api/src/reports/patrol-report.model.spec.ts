import { computeCompliance, patrolRulesSchema } from '@sentrycore/shared';

import {
  construirInformeRonda,
  etiquetaAnomalia,
  resumirTareas,
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
 * Estos tests NO importan pdfkit: prueban la composicion del informe —que filas
 * salen, cual queda marcada omitida, que pasa con la evidencia— y no el binario
 * del PDF, que no dice nada util cuando se rompe.
 */

const UMBRAL = patrolRulesSchema.parse({}).complianceThreshold;

const MARCA: MarcaDocumento = {
  displayName: 'Seguridad Demo SpA',
  logoUri: null,
  primaryColor: '#1f3b73',
  mailFooter: 'Seguridad Demo SpA · Av. Siempre Viva 123',
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
  // scan_id es NOT NULL en scan_photos: no existe la foto huerfana de escaneo.
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

/**
 * Fila cruda de tarea TAL COMO la entrega el driver, no como uno querria que
 * viniera: `due_local_time` es un string ('11:00:00') porque la columna es
 * `time`, y `late_minutes` puede ser null. Ese detalle es el que se prueba.
 */
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

/** La misma tarea, ya respondida por el guardia. */
const respondida = (parcial: Partial<TareaRow> = {}): TareaRow =>
  tarea({
    response_id: 'rs-1',
    value: 'ok',
    failed: false,
    responded_at: new Date('2026-07-31T00:05:00-04:00'),
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

describe('construirInformeRonda · filas de puntos', () => {
  it('devuelve una fila por punto esperado, en el orden efectivo de la ronda', () => {
    // El orden viene de expected_checkpoint_ids, que puede estar sorteado por
    // randomizeRouteOrder: el informe respeta ese orden, no el de la ruta.
    const revueltos: PuntoEsperadoRow[] = [PUNTOS[2]!, PUNTOS[0]!, PUNTOS[1]!];
    const informe = construirInformeRonda(entrada({ puntos: revueltos }));

    expect(informe.puntos.map((p) => p.checkpointId)).toEqual(['cp-3', 'cp-1', 'cp-2']);
    expect(informe.puntos.map((p) => p.numero)).toEqual([1, 2, 3]);
  });

  it('marca omitido exactamente lo que declara computeCompliance', () => {
    const scans = [escaneo('cp-1', '2026-07-30T23:10:00-04:00')];
    const informe = construirInformeRonda(entrada({ scans }));

    const esperado = computeCompliance(
      PUNTOS.map((p) => p.id),
      [{ checkpointId: 'cp-1', anomalies: [] }],
      UMBRAL,
    );
    expect(informe.compliance).toEqual(esperado);
    expect(informe.puntos.filter((p) => p.omitido).map((p) => p.checkpointId)).toEqual(
      esperado.missedCheckpointIds,
    );
    expect(informe.omitidos.map((p) => p.nombre)).toEqual(['Bodega', 'Portería']);
    // 1 de 3 = 33%, bajo el umbral por defecto de 70.
    expect(informe.compliance.pct).toBe(33);
    expect(informe.compliance.belowThreshold).toBe(true);
  });

  it('una ronda sin ningún escaneo deja todos los puntos omitidos y 0%', () => {
    const informe = construirInformeRonda(entrada());

    expect(informe.compliance.pct).toBe(0);
    expect(informe.omitidos).toHaveLength(3);
    expect(informe.puntos.every((p) => p.omitido && p.escaneadoEn === null)).toBe(true);
  });

  it('una ronda completa no deja ningún punto omitido', () => {
    const scans = PUNTOS.map((p, i) => escaneo(p.id, `2026-07-30T2${i}:00:00-04:00`));
    const informe = construirInformeRonda(entrada({ scans }));

    expect(informe.omitidos).toEqual([]);
    expect(informe.compliance.pct).toBe(100);
    expect(informe.compliance.belowThreshold).toBe(false);
  });

  it('con varias lecturas del mismo punto muestra la PRIMERA, no la última', () => {
    // El guardia reintenta, o la cola offline reenvia el lote: la hora que
    // importa es cuando estuvo ahi por primera vez.
    const scans = [
      escaneo('cp-1', '2026-07-30T23:40:00-04:00'),
      escaneo('cp-1', '2026-07-30T23:10:00-04:00', { method: 'qr' }),
    ];
    const informe = construirInformeRonda(entrada({ scans }));

    expect(informe.puntos[0]!.escaneadoEn).toEqual(new Date('2026-07-30T23:10:00-04:00'));
    expect(informe.puntos[0]!.metodo).toBe('qr');
  });

  it('el escaneo con anomalía cuenta como cumplido pero la fila la conserva', () => {
    // Decision del dominio: descartar el escaneo castigaria al guardia por un
    // GPS impreciso en un subterraneo. Se marca y decide una persona.
    const scans = PUNTOS.map((p) => escaneo(p.id, '2026-07-30T23:00:00-04:00'));
    scans[1] = escaneo('cp-2', '2026-07-30T23:20:00-04:00', {
      anomalies: ['fuera_de_radio_gps', 'sin_fix_gps'],
    });
    const informe = construirInformeRonda(entrada({ scans }));

    expect(informe.compliance.pct).toBe(100);
    expect(informe.puntos[1]!.omitido).toBe(false);
    expect(informe.puntos[1]!.anomalias).toEqual(['fuera_de_radio_gps', 'sin_fix_gps']);
    expect(informe.compliance.clean).toBe(2);
  });

  it('respeta el umbral del tenant y no el default del producto', () => {
    const scans = PUNTOS.map((p) => escaneo(p.id, '2026-07-30T23:00:00-04:00'));
    const informe = construirInformeRonda(entrada({ scans, umbral: 100 }));

    expect(informe.umbral).toBe(100);
    expect(informe.compliance.belowThreshold).toBe(false);
  });

  it('conserva punto de cierre y acceso crítico para marcarlos en la tabla', () => {
    const informe = construirInformeRonda(entrada());
    expect(informe.puntos[2]).toMatchObject({ esCierre: true, esCritico: true });
    expect(informe.puntos[0]).toMatchObject({ esCierre: false, esCritico: false });
  });

  it('anomalies en null desde la base no revienta el cálculo', () => {
    const scans = [
      { ...escaneo('cp-1', '2026-07-30T23:00:00-04:00'), anomalies: null as never },
    ];
    const informe = construirInformeRonda(entrada({ scans }));

    expect(informe.puntos[0]!.omitido).toBe(false);
    expect(informe.puntos[0]!.anomalias).toEqual([]);
  });
});

describe('construirInformeRonda · anexo fotográfico', () => {
  it('ordena la evidencia por punto de la ronda y le pone su correlativo', () => {
    // El orden ya NO es el de `created_at` (#308): esa es la hora de SUBIDA y
    // con la cola offline la misma ronda sincronizada mas tarde produciria otra
    // numeracion para las mismas fotos.
    const informe = construirInformeRonda(
      entrada({ fotos: [foto('f1', 'cp-3'), foto('f2', 'cp-1')] }),
    );

    expect(informe.anexo.map((f) => f.numeroPunto)).toEqual([1, 3]);
    expect(informe.anexo.map((f) => f.numero)).toEqual([1, 2]);
    expect(informe.anexo[1]!.huella).toBe('a'.repeat(12));
    expect(informe.anexo[1]!.sizeBytes).toBe(204800);
  });

  it('el número de foto no cambia aunque cambie la hora de subida', () => {
    const enVivo = construirInformeRonda(
      entrada({
        fotos: [
          foto('f1', 'cp-1', { created_at: new Date('2026-07-31T00:10:00-04:00') }),
          foto('f2', 'cp-3', { created_at: new Date('2026-07-31T00:20:00-04:00') }),
        ],
      }),
    );
    // La misma ronda, resincronizada al reves desde un subterraneo.
    const resincronizada = construirInformeRonda(
      entrada({
        fotos: [
          foto('f2', 'cp-3', { created_at: new Date('2026-07-31T09:00:00-04:00') }),
          foto('f1', 'cp-1', { created_at: new Date('2026-07-31T09:05:00-04:00') }),
        ],
      }),
    );

    const numeroDe = (informe: ReturnType<typeof construirInformeRonda>, id: string) =>
      informe.anexo.find((f) => f.id === id)?.numero;
    expect(numeroDe(enVivo, 'f1')).toBe(numeroDe(resincronizada, 'f1'));
    expect(numeroDe(enVivo, 'f2')).toBe(numeroDe(resincronizada, 'f2'));
  });

  it('la foto de un punto fuera de la ronda igual entra al anexo, sin número', () => {
    // Evidencia tomada en terreno: perderla del informe seria peor que no poder
    // numerarla.
    const informe = construirInformeRonda(
      entrada({ fotos: [foto('f1', 'cp-fuera', { checkpoint_name: 'Patio trasero' })] }),
    );

    expect(informe.anexo).toHaveLength(1);
    expect(informe.anexo[0]).toMatchObject({ numeroPunto: null, checkpointName: 'Patio trasero' });
  });

  it('prefiere la hora del dispositivo cuando existe', () => {
    const tomada = new Date('2026-07-31T05:30:00-04:00');
    const informe = construirInformeRonda(
      entrada({ fotos: [foto('f1', 'cp-3', { taken_at_device: tomada })] }),
    );

    expect(informe.anexo[0]!.capturadaEn).toEqual(tomada);
  });

  it('sin anexo el informe se genera igual: es el modo del adjunto por correo', () => {
    const informe = construirInformeRonda(
      entrada({ fotos: [foto('f1', 'cp-3')], incluirAnexo: false }),
    );

    expect(informe.anexo).toEqual([]);
    expect(informe.incluyeAnexo).toBe(false);
    expect(informe.puntos).toHaveLength(3);
  });

  it('sin anexo la evidencia igual queda registrada: se esconden los bytes, no el hecho', () => {
    // Antes de #308, el informe que viaja adjunto al correo ni siquiera sabia
    // que la ronda habia tenido fotos, asi que quien lo recibia no tenia como
    // enterarse de que habia evidencia esperandolo en el panel.
    const informe = construirInformeRonda(
      entrada({ fotos: [foto('f1', 'cp-3'), foto('f2', 'cp-1')], incluirAnexo: false }),
    );

    expect(informe.anexo).toEqual([]);
    expect(informe.evidencias).toHaveLength(2);
    expect(informe.evidencias.map((f) => f.numero)).toEqual([1, 2]);
  });

  it('una ronda sin fotos no rompe nada', () => {
    const informe = construirInformeRonda(entrada());
    expect(informe.anexo).toEqual([]);
    expect(informe.evidencias).toEqual([]);
    expect(informe.incluyeAnexo).toBe(true);
  });
});

describe('construirInformeRonda · duración e instrucciones', () => {
  it('deriva la duración de inicio y cierre, que no existe como columna', () => {
    // 22:05 -> 05:40 del dia siguiente = 7 h 35 min = 455 min.
    expect(construirInformeRonda(entrada()).duracionMin).toBe(455);
  });

  it('una ronda sin cierre no inventa una duración', () => {
    const informe = construirInformeRonda(
      entrada({ ronda: { ...RONDA, closed_at: null } }),
    );
    expect(informe.duracionMin).toBeNull();
  });

  it('trae las instrucciones del punto, que la consulta no leía', () => {
    const informe = construirInformeRonda(
      entrada({
        puntos: [
          { ...PUNTOS[0]!, instructions: '  Revisar que el portón quede con candado  ' },
          PUNTOS[1]!,
        ],
      }),
    );

    expect(informe.puntos[0]!.instrucciones).toBe('Revisar que el portón quede con candado');
    // Sin instrucciones cargadas es null, no una cadena vacia que el informe
    // imprimiria como una linea en blanco.
    expect(informe.puntos[1]!.instrucciones).toBeNull();
  });
});

describe('construirInformeRonda · incidentes y marca', () => {
  const incidente = (parcial: Partial<IncidenteRow> = {}): IncidenteRow => ({
    id: 'ev-1',
    criticality: 'media',
    text: 'Luminaria del pasillo B quemada',
    reported_at_server: new Date('2026-07-31T01:00:00-04:00'),
    ...parcial,
  });

  it('destaca solo las criticidades que configura el tenant', () => {
    const informe = construirInformeRonda(
      entrada({
        incidentes: [incidente(), incidente({ id: 'ev-2', criticality: 'alta' })],
        criticidadesDestacadas: ['alta', 'panico'],
      }),
    );

    expect(informe.incidentes.map((i) => i.destacado)).toEqual([false, true]);
  });

  it('el pánico sin texto no queda con la celda vacía', () => {
    // field_events permite text NULL solo para 'panico': el boton es un toque.
    const informe = construirInformeRonda(
      entrada({ incidentes: [incidente({ criticality: 'panico', text: null })] }),
    );

    expect(informe.incidentes[0]!.texto).toBe('Sin descripción');
    expect(informe.incidentes[0]!.destacado).toBe(true);
  });

  it('estampa la marca del tenant recibida, no un nombre fijo', () => {
    const otra: MarcaDocumento = {
      displayName: 'Vigilancia Austral Ltda',
      logoUri: 'data:image/png;base64,AAAA',
      primaryColor: '#7a1f1f',
      mailFooter: null,
    };
    const informe = construirInformeRonda(entrada({ marca: otra }));

    expect(informe.marca).toEqual(otra);
    expect(informe.filename).toBe('informe-ronda-patrol-id.pdf');
  });
});

describe('construirInformeRonda · tareas del turno', () => {
  it('lista la tarea aunque nadie la haya respondido, y la marca pendiente', () => {
    // Es el caso que mas importa del informe: la tarea NO hecha no tiene fila en
    // checklist_responses, y si el modelo solo mirara las respuestas seria
    // invisible justo cuando hay que reclamarla.
    const informe = construirInformeRonda(entrada({ tareas: [tarea()] }));

    expect(informe.tareas).toHaveLength(1);
    expect(informe.tareas[0]).toMatchObject({
      etiqueta: 'Fotografiar el refrigerador',
      estado: 'pendiente',
      respuesta: null,
      respondidaEn: null,
    });
  });

  it('la hora pedida sale como "11:00" desde el string que entrega el driver', () => {
    // due_local_time es `time` en PostgreSQL: llega '11:00:00', NO un Date. Si
    // el informe lo tratara como fecha, new Date('11:00:00') seria invalido y la
    // celda quedaria en '—' — la hora que el producto pidio mostrar.
    const informe = construirInformeRonda(
      entrada({ tareas: [tarea({ due_local_time: '11:00:00' })] }),
    );

    expect(informe.tareas[0]!.horaPedida).toBe('11:00');
  });

  it('sin hora pedida la tarea vale para cualquier momento de la ronda', () => {
    const informe = construirInformeRonda(entrada({ tareas: [tarea()] }));
    expect(informe.tareas[0]!.horaPedida).toBeNull();
  });

  it('cruza el punto de la tarea con su número en la ronda', () => {
    const informe = construirInformeRonda(
      entrada({
        tareas: [
          tarea({ checkpoint_id: 'cp-3', checkpoint_name: 'Portería' }),
          tarea({ item_id: 'it-2', label: 'Revisar bitácora' }),
        ],
      }),
    );

    expect(informe.tareas[0]).toMatchObject({ numeroPunto: 3, punto: 'Portería' });
    // checkpoint_id NULL = tarea general del turno, no un punto sin nombre.
    expect(informe.tareas[1]).toMatchObject({ numeroPunto: null, punto: null });
  });

  it('la tarea de un punto que no está en el orden de la ronda no pierde el nombre', () => {
    const informe = construirInformeRonda(
      entrada({
        tareas: [tarea({ checkpoint_id: 'cp-fuera', checkpoint_name: 'Patio trasero' })],
      }),
    );

    expect(informe.tareas[0]).toMatchObject({ numeroPunto: null, punto: 'Patio trasero' });
  });

  it('el atraso se LEE de late_minutes y no se recalcula con responded_at', () => {
    // Quien registro la respuesta ya midio el atraso contra la zona del recinto.
    // Si el informe volviera a calcularlo podria contradecir a la cifra que el
    // guardia y el supervisor ya vieron, igual que pasaria recalculando omitido.
    const informe = construirInformeRonda(
      entrada({
        tareas: [
          respondida({
            due_local_time: '11:00:00',
            late_minutes: 35,
            responded_at: new Date('2026-07-31T20:00:00-04:00'),
          }),
        ],
      }),
    );

    expect(informe.tareas[0]!.atrasoMinutos).toBe(35);
    expect(informe.tareas[0]!.atrasada).toBe(true);
  });

  it('respondida a tiempo no queda marcada como atrasada', () => {
    const informe = construirInformeRonda(
      entrada({ tareas: [respondida({ due_local_time: '11:00:00', late_minutes: 0 })] }),
    );

    expect(informe.tareas[0]!.atrasoMinutos).toBe(0);
    expect(informe.tareas[0]!.atrasada).toBe(false);
  });

  it('la tarea atrasada se acepta igual: sigue siendo una respuesta cumplida', () => {
    // Regla del producto: "si la tarea queda fuera del horario de la ronda, que
    // se envie igual". El atraso se menciona, no invalida.
    const informe = construirInformeRonda(
      entrada({ tareas: [respondida({ late_minutes: 120 })] }),
    );

    expect(informe.tareas[0]!.estado).toBe('cumplida');
    expect(informe.tareas[0]!.atrasada).toBe(true);
  });

  it('la falla se marca como estado propio', () => {
    const informe = construirInformeRonda(
      entrada({ tareas: [respondida({ value: 'falla', failed: true })] }),
    );

    expect(informe.tareas[0]).toMatchObject({ estado: 'falla', respuesta: 'falla' });
  });

  it('la tarea con foto obligatoria y sin foto queda marcada', () => {
    // Puede pasar sin que nadie haga trampa: la purga por retencion pone
    // photo_id en NULL. El informe tiene que decirlo, no callarlo.
    const informe = construirInformeRonda(
      entrada({ tareas: [respondida({ requires_photo: true, photo_id: null })] }),
    );

    expect(informe.tareas[0]).toMatchObject({ exigeFoto: true, faltaFoto: true });
  });

  it('con la foto adjunta la tarea de foto obligatoria no reclama nada', () => {
    const informe = construirInformeRonda(
      entrada({ tareas: [respondida({ requires_photo: true, photo_id: 'f1' })] }),
    );

    expect(informe.tareas[0]).toMatchObject({ exigeFoto: true, faltaFoto: false, fotoId: 'f1' });
  });

  it('la falla que exige foto solo al fallar también cuenta como foto faltante', () => {
    const informe = construirInformeRonda(
      entrada({
        tareas: [respondida({ value: 'falla', failed: true, requires_photo_on_fail: true })],
      }),
    );

    expect(informe.tareas[0]).toMatchObject({ estado: 'falla', faltaFoto: true });
  });

  it('la tarea pendiente no se acusa además de "sin foto"', () => {
    // Lo que falta ahi es la tarea entera; marcarle tambien la foto es ruido que
    // hace desconfiar del resto de la tabla.
    const informe = construirInformeRonda(
      entrada({ tareas: [tarea({ requires_photo: true })] }),
    );

    expect(informe.tareas[0]).toMatchObject({ estado: 'pendiente', faltaFoto: false });
  });

  it('las tareas NO alteran el porcentaje de cumplimiento', () => {
    // El cumplimiento es sobre puntos escaneados. Si una tarea moviera ese
    // numero, el encabezado dejaria de cuadrar con la tabla de puntos.
    const scans = PUNTOS.map((p) => escaneo(p.id, '2026-07-30T23:00:00-04:00'));
    const conTareas = construirInformeRonda(
      entrada({
        scans,
        tareas: [tarea(), respondida({ item_id: 'it-2', value: 'falla', failed: true })],
      }),
    );
    const sinTareas = construirInformeRonda(entrada({ scans }));

    expect(conTareas.compliance).toEqual(sinTareas.compliance);
    expect(conTareas.compliance.pct).toBe(100);
  });

  it('una ronda sin checklist deja la lista vacía y no rompe nada', () => {
    const informe = construirInformeRonda(entrada());

    expect(informe.tareas).toEqual([]);
    expect(resumirTareas(informe.tareas)).toMatchObject({ total: 0, pendientes: 0 });
  });

  it('rotula la foto del anexo con la tarea que la exigió', () => {
    const informe = construirInformeRonda(
      entrada({
        fotos: [foto('f1', 'cp-3'), foto('f2', 'cp-1')],
        tareas: [respondida({ requires_photo: true, photo_id: 'f1' })],
      }),
    );

    const reclamada = informe.anexo.find((f) => f.id === 'f1');
    expect(reclamada?.tarea).toBe('Fotografiar el refrigerador');
    expect(reclamada?.tareaId).toBe('it-1');
    // La foto de un escaneo normal sigue sin rotulo de tarea.
    expect(informe.anexo.find((f) => f.id === 'f2')?.tarea).toBeNull();
  });
});

describe('resumirTareas', () => {
  it('cuenta lo que el informe tiene que mencionar', () => {
    const informe = construirInformeRonda(
      entrada({
        tareas: [
          respondida({ item_id: 'it-1' }),
          respondida({ item_id: 'it-2', value: 'falla', failed: true }),
          respondida({ item_id: 'it-3', late_minutes: 42 }),
          respondida({ item_id: 'it-4', requires_photo: true }),
          tarea({ item_id: 'it-5' }),
        ],
      }),
    );

    expect(resumirTareas(informe.tareas)).toEqual({
      total: 5,
      cumplidas: 3,
      fallidas: 1,
      pendientes: 1,
      atrasadas: 1,
      sinFoto: 1,
    });
  });
});

describe('etiquetaAnomalia', () => {
  it('vuelve legible la marca del enum', () => {
    expect(etiquetaAnomalia('fuera_de_radio_gps')).toBe('fuera de radio gps');
    expect(etiquetaAnomalia('velocidad_imposible')).toBe('velocidad imposible');
  });
});
