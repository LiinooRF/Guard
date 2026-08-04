import { computeCompliance, patrolRulesSchema } from '@voxia/shared';

import {
  construirInformeRonda,
  etiquetaAnomalia,
  type EncabezadoRondaRow,
  type EntradaModelo,
  type FotoRow,
  type IncidenteRow,
  type PuntoEsperadoRow,
  type ScanRow,
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
  it('numera cada foto con el punto de la ronda al que pertenece', () => {
    const informe = construirInformeRonda(
      entrada({ fotos: [foto('f1', 'cp-3'), foto('f2', 'cp-1')] }),
    );

    expect(informe.anexo.map((f) => f.numeroPunto)).toEqual([3, 1]);
    expect(informe.anexo[0]!.huella).toBe('a'.repeat(12));
    expect(informe.anexo[0]!.sizeBytes).toBe(204800);
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

  it('una ronda sin fotos no rompe nada', () => {
    const informe = construirInformeRonda(entrada());
    expect(informe.anexo).toEqual([]);
    expect(informe.incluyeAnexo).toBe(true);
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

describe('etiquetaAnomalia', () => {
  it('vuelve legible la marca del enum', () => {
    expect(etiquetaAnomalia('fuera_de_radio_gps')).toBe('fuera de radio gps');
    expect(etiquetaAnomalia('velocidad_imposible')).toBe('velocidad imposible');
  });
});
