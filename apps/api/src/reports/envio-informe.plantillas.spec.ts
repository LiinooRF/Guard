import { renderTemplate } from '../mail/template-renderer';
import {
  INFORME_AL_CIERRE,
  INFORME_BAJO_UMBRAL,
  lineaAdjunto,
  variablesInforme,
  type DatosCorreoInforme,
} from './envio-informe.plantillas';

/**
 * Las plantillas del envio automatico (#86).
 *
 * El test que mas vale es el ultimo: renderiza con el renderer DE VERDAD. Ese
 * renderer lanza cuando falta una variable, asi que si alguien agrega un
 * {{campo}} a la plantilla y se olvida de llenarlo, el correo no se caeria en un
 * test sino en produccion, y justo el correo que importa es la alerta.
 */

const DATOS: DatosCorreoInforme = {
  ruta: 'Ronda nocturna',
  recinto: 'Planta Norte',
  sucursal: 'Casa matriz',
  guardia: 'Juan Soto',
  timezone: 'America/Santiago',
  inicio: new Date('2026-07-30T22:05:00-04:00'),
  cierre: new Date('2026-07-31T05:40:00-04:00'),
  compliance: {
    expected: 5,
    scanned: 3,
    clean: 3,
    pct: 60,
    missedCheckpointIds: ['cp-4', 'cp-5'],
    belowThreshold: true,
  },
  umbral: 70,
  novedades: 1,
  adjunto: {
    incluido: true,
    filename: 'informe-ronda-abc.pdf',
    bytes: 412_000,
    maxMB: 5,
  },
  pie: 'Vigilancia Austral Ltda',
};

/** Los {{campos}} que la plantilla exige. */
function marcadores(texto: string): string[] {
  return [...texto.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_.-]*)\s*\}\}/g)].map((m) => m[1] as string);
}

describe('plantillas del envio automatico', () => {
  it('el informe y la alerta tienen asuntos distintos', () => {
    // Si fueran iguales, la alerta se perderia entre los informes de todos los
    // dias, que es el problema que este issue viene a resolver.
    expect(INFORME_BAJO_UMBRAL.subject).not.toBe(INFORME_AL_CIERRE.subject);
  });

  it('cubre todos los marcadores de las dos plantillas', () => {
    const variables = variablesInforme(DATOS);
    for (const plantilla of [INFORME_AL_CIERRE, INFORME_BAJO_UMBRAL]) {
      for (const campo of [...marcadores(plantilla.subject), ...marcadores(plantilla.text)]) {
        expect(Object.keys(variables)).toContain(campo);
      }
    }
  });

  it('se renderiza sin lanzar, con el renderer real', () => {
    const variables = variablesInforme(DATOS);
    const informe = renderTemplate(INFORME_AL_CIERRE, variables);
    const alerta = renderTemplate(INFORME_BAJO_UMBRAL, variables);

    expect(informe.subject).toContain('60%');
    expect(alerta.subject).toContain('Planta Norte');
    expect(alerta.text).toContain('bajo el mínimo de 70%');
    expect(alerta.text).toContain('Puntos sin marcar: 2 de 5');
  });

  it('las horas salen en la zona del recinto y no en la del servidor', () => {
    const texto = renderTemplate(INFORME_AL_CIERRE, variablesInforme(DATOS)).text;
    // 05:40 en Santiago; en UTC ese mismo instante son las 09:40. Si el
    // servidor impusiera su zona, el informe diria una hora en la que el
    // guardia no estaba en el recinto.
    expect(texto).toContain('05:40');
    expect(texto).not.toContain('09:40');
  });

  it('un tenant sin pie de marca no rompe el correo', () => {
    const variables = variablesInforme({ ...DATOS, pie: null });
    expect(() => renderTemplate(INFORME_AL_CIERRE, variables)).not.toThrow();
  });

  it('sin adjunto, el correo explica que hacer', () => {
    const linea = lineaAdjunto({
      incluido: false,
      filename: 'informe-ronda-abc.pdf',
      bytes: 12 * 1024 * 1024,
      maxMB: 5,
    });
    expect(linea).toContain('12,0 MB');
    expect(linea).toContain('5 MB');
    expect(linea).toContain('panel');
  });

  it('con adjunto, dice el nombre del archivo y cuanto pesa', () => {
    const linea = lineaAdjunto(DATOS.adjunto);
    expect(linea).toContain('informe-ronda-abc.pdf');
    expect(linea).toContain('0,4 MB');
  });
});
