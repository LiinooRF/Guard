import type { ComplianceResult } from '@sentrycore/shared';

import type { MailTemplate, MailTemplateVariables } from '../mail/mail-provider';
import { formatearFechaHora } from './pdf-primitivas';

/**
 * Plantillas del correo que sale solo al cerrarse la ronda (#86).
 *
 * Escritas para un jefe de operaciones, no para un ingeniero: la primera linea
 * dice que paso, la segunda cuanto se cumplio, y recien despues el detalle.
 * Quien lo lee esta viendo el correo en el telefono a las tres de la mañana.
 *
 * SON DOS ASUNTOS DISTINTOS A PROPOSITO. El informe de todos los dias y la
 * ronda que quedo bajo el minimo no pueden verse iguales en la bandeja: si el
 * asunto fuera el mismo, la alerta se perderia entre los informes normales, que
 * es exactamente lo que este issue evita.
 *
 * Solo texto plano, igual que el resto de las plantillas del producto: el
 * contenido que importa va en el PDF adjunto, y un correo de texto llega igual
 * de bien a Outlook corporativo que al telefono del supervisor.
 */

/** Informe normal: cierre de ronda, con o sin adjunto. */
export const INFORME_AL_CIERRE: MailTemplate = {
  subject: 'Informe de ronda — {{recinto}}: {{ruta}} ({{cumplimiento}}%)',
  text:
    'La ronda "{{ruta}}" del recinto {{recinto}} ({{sucursal}}) quedó cerrada.\n\n' +
    'Cumplimiento: {{cumplimiento}}% — {{escaneados}} de {{esperados}} puntos marcados ' +
    '({{omitidos}} sin marcar).\n' +
    'Mínimo configurado: {{umbral}}%\n' +
    'Guardia: {{guardia}}\n' +
    'Inicio: {{inicio}}\n' +
    'Cierre: {{cierre}}\n' +
    'Novedades registradas: {{novedades}}\n\n' +
    '{{adjunto}}\n\n' +
    'Las horas están en la hora del recinto.\n' +
    'Este correo salió solo al marcarse el último punto. Para cambiar quién lo ' +
    'recibe, edita los destinatarios del informe en la configuración del recinto.\n' +
    '{{pie}}',
};

/**
 * Alerta bajo umbral: va DIRECTO al admin, ademas del informe normal.
 *
 * Lleva el mismo PDF adjunto. La regla que dio origen al producto es que el
 * administrador se entere de la ronda mala sin tener que entrar a buscarla.
 */
export const INFORME_BAJO_UMBRAL: MailTemplate = {
  subject: 'Cumplimiento bajo el mínimo — {{recinto}}: {{ruta}} ({{cumplimiento}}%)',
  text:
    'La ronda "{{ruta}}" del recinto {{recinto}} ({{sucursal}}) cerró con {{cumplimiento}}% ' +
    'de cumplimiento, bajo el mínimo de {{umbral}}% que definiste.\n\n' +
    'Puntos sin marcar: {{omitidos}} de {{esperados}}\n' +
    'Guardia: {{guardia}}\n' +
    'Inicio: {{inicio}}\n' +
    'Cierre: {{cierre}}\n' +
    'Novedades registradas: {{novedades}}\n\n' +
    '{{adjunto}}\n\n' +
    'Recibes este aviso porque administras la empresa. El informe lista punto por ' +
    'punto cuáles quedaron sin marcar y a qué hora se marcó cada uno.\n' +
    'Las horas están en la hora del recinto.\n' +
    '{{pie}}',
};

export interface AdjuntoInforme {
  /** false = el PDF supero el maximo y el correo sale con la instruccion. */
  readonly incluido: boolean;
  readonly filename: string;
  readonly bytes: number;
  /** Maximo configurado en las reglas, en megabytes. */
  readonly maxMB: number;
}

export interface DatosCorreoInforme {
  readonly ruta: string;
  readonly recinto: string;
  readonly sucursal: string;
  readonly guardia: string;
  /** Zona horaria DEL RECINTO (sites.timezone), nunca la del servidor. */
  readonly timezone: string;
  readonly inicio: Date | null;
  readonly cierre: Date | null;
  readonly compliance: ComplianceResult;
  readonly umbral: number;
  readonly novedades: number;
  readonly adjunto: AdjuntoInforme;
  /** Pie de marca del tenant; null cuando no configuro ninguno. */
  readonly pie: string | null;
}

/**
 * Variables de las dos plantillas.
 *
 * Las dos usan el MISMO juego de variables: asi no existe el caso de que la
 * alerta se caiga por una variable que solo tenia el informe. El renderer lanza
 * si falta una, y un correo de alerta que no sale es peor que uno feo.
 */
export function variablesInforme(datos: DatosCorreoInforme): MailTemplateVariables {
  return {
    ruta: datos.ruta,
    recinto: datos.recinto,
    sucursal: datos.sucursal,
    guardia: datos.guardia,
    cumplimiento: datos.compliance.pct,
    umbral: datos.umbral,
    esperados: datos.compliance.expected,
    escaneados: datos.compliance.scanned,
    omitidos: datos.compliance.missedCheckpointIds.length,
    inicio: formatearFechaHora(datos.inicio, datos.timezone),
    cierre: formatearFechaHora(datos.cierre, datos.timezone),
    novedades: datos.novedades,
    adjunto: lineaAdjunto(datos.adjunto),
    // Cadena vacia y no null: el renderer trata null como variable faltante y
    // lanza, y un tenant sin pie de marca es lo normal, no un error.
    pie: datos.pie ?? '',
  };
}

/**
 * La linea del adjunto. Cuando el PDF no viaja, el correo dice que hacer en vez
 * de callarse: un informe que "no llego" y nadie explica termina en un llamado
 * al soporte.
 */
export function lineaAdjunto(adjunto: AdjuntoInforme): string {
  if (adjunto.incluido) {
    return `Adjunto: ${adjunto.filename} (${enMegabytes(adjunto.bytes)} MB).`;
  }
  return (
    `El informe no viajó adjunto: pesa ${enMegabytes(adjunto.bytes)} MB y el máximo ` +
    `configurado para correo es ${adjunto.maxMB} MB. Descárgalo desde el detalle de ` +
    `la ronda, en el panel.`
  );
}

/** Un decimal y coma decimal, como se escriben los numeros en Chile. */
function enMegabytes(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1).replace('.', ',');
}
