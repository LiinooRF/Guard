import type { MailTemplate } from './mail-provider';
import {
  maquetaHtml,
  maquetaTexto,
  type ContenidoCorreo,
  type FormaMarca,
} from './plantillas-maqueta';

/**
 * Las cuatro plantillas de correo del producto (#42).
 *
 * QUE CAMBIA RESPECTO DE LO QUE HABIA
 * Las de invitacion y recuperacion vivian escritas a mano dentro de
 * auth/mail.service.ts y decian "SentryCore" con todas sus letras: al
 * cliente final de una empresa de seguridad le llegaba la marca del revendedor.
 * Las de informe y alerta ya estaban bien escritas en
 * reports/envio-informe.plantillas.ts pero eran solo texto y sin marca.
 *
 * Este catalogo las unifica: mismo asunto de siempre para las de informe —los
 * ASUNTOS DEL INFORME Y DE LA ALERTA SIGUEN SIENDO DISTINTOS A PROPOSITO, si
 * fueran iguales la alerta se perderia entre los informes de todos los dias— y
 * las mismas variables, para que el reemplazo en EnvioInformeService sea una
 * linea y no una reescritura.
 *
 * NINGUN TEXTO FIJO LLEVA DATOS: todo lo que cambia por empresa, por ronda o
 * por persona entra como `{{marcador}}` y lo sustituye template-renderer.ts,
 * que ademas escapa el valor en el HTML. Pegar el nombre de la empresa dentro
 * de la plantilla en vez de pasarlo como variable tiene un modo de falla
 * concreto: una empresa que se llame con dos llaves en el nombre haria que el
 * renderer buscara una variable inexistente y el correo no saldria nunca.
 */

export const CLAVES_PLANTILLA = [
  'invitacion',
  'recuperacion',
  'informe-ronda',
  'alerta-cumplimiento',
] as const;

export type ClavePlantilla = (typeof CLAVES_PLANTILLA)[number];

export interface FichaPlantilla {
  readonly clave: ClavePlantilla;
  /** Como se llama en el panel del admin. */
  readonly titulo: string;
  /** Cuando sale, en lenguaje del cliente. */
  readonly cuando: string;
  readonly asunto: string;
  readonly contenido: ContenidoCorreo;
}

/** Los datos de la ronda. Los usan la plantilla de informe y la de alerta. */
const DATOS_DE_RONDA = [
  { etiqueta: 'Cumplimiento', valor: '{{cumplimiento}}%' },
  { etiqueta: 'Puntos marcados', valor: '{{escaneados}} de {{esperados}}' },
  { etiqueta: 'Puntos sin marcar', valor: '{{omitidos}}' },
  { etiqueta: 'Mínimo configurado', valor: '{{umbral}}%' },
  { etiqueta: 'Guardia', valor: '{{guardia}}' },
  { etiqueta: 'Inicio', valor: '{{inicio}}' },
  { etiqueta: 'Cierre', valor: '{{cierre}}' },
  { etiqueta: 'Novedades registradas', valor: '{{novedades}}' },
] as const;

/**
 * Las horas llegan YA FORMATEADAS en la zona horaria del recinto, desde
 * `variablesInforme()` en reports/envio-informe.plantillas.ts. Aca no se hace
 * ninguna cuenta con fechas a proposito: la zona del recinto no es la del
 * servidor y esa conversion tiene un solo lugar donde vivir.
 */
const NOTA_HORAS = 'Las horas están en la hora del recinto.';

export const CATALOGO_PLANTILLAS: Record<ClavePlantilla, FichaPlantilla> = {
  invitacion: {
    clave: 'invitacion',
    titulo: 'Invitación de usuario',
    cuando: 'Cuando se crea un usuario con correo, para que defina su contraseña.',
    asunto: 'Activa tu acceso a {{marcaNombre}}',
    contenido: {
      preheader: 'Define tu contraseña. El enlace vence en {{vigencia}}.',
      encabezado: 'Tu acceso ya está creado',
      parrafos: [
        '{{marcaNombre}} te habilitó una cuenta para el sistema de rondas de vigilancia.',
        'Define tu contraseña para entrar. El enlace sirve una sola vez y vence en {{vigencia}}.',
      ],
      datos: [],
      boton: { etiqueta: 'Definir mi contraseña', href: '{{enlace}}' },
      enlaceVisible: '{{enlace}}',
      notas: [
        'Si no esperabas este correo, ignóralo: mientras no definas la contraseña, la cuenta no queda activa.',
      ],
    },
  },

  recuperacion: {
    clave: 'recuperacion',
    titulo: 'Recuperación de contraseña',
    cuando: 'Cuando alguien pide recuperar su contraseña desde la pantalla de ingreso.',
    asunto: 'Recupera tu acceso a {{marcaNombre}}',
    contenido: {
      preheader: 'Define una contraseña nueva. El enlace vence en {{vigencia}}.',
      encabezado: 'Cambia tu contraseña',
      parrafos: [
        'Recibimos una solicitud para cambiar la contraseña de tu cuenta en {{marcaNombre}}.',
        'Si fuiste tú, define una nueva. El enlace sirve una sola vez y vence en {{vigencia}}.',
      ],
      datos: [],
      boton: { etiqueta: 'Definir contraseña nueva', href: '{{enlace}}' },
      enlaceVisible: '{{enlace}}',
      notas: [
        'Si no pediste el cambio, ignora este correo: tu contraseña actual sigue funcionando y nadie más puede usar este enlace.',
      ],
    },
  },

  'informe-ronda': {
    clave: 'informe-ronda',
    titulo: 'Informe de ronda',
    cuando: 'Al marcarse el último punto de una ronda, con el informe en PDF adjunto.',
    asunto: 'Informe de ronda — {{recinto}}: {{ruta}} ({{cumplimiento}}%)',
    contenido: {
      preheader: '{{cumplimiento}}% de cumplimiento en {{recinto}}.',
      encabezado: 'Ronda cerrada en {{recinto}}',
      parrafos: [
        'La ronda "{{ruta}}" del recinto {{recinto}} ({{sucursal}}) quedó cerrada.',
        '{{adjunto}}',
      ],
      datos: [...DATOS_DE_RONDA],
      boton: null,
      enlaceVisible: null,
      notas: [
        NOTA_HORAS,
        'Este correo salió solo al marcarse el último punto. Para cambiar quién lo recibe, edita los destinatarios del informe en la configuración del recinto.',
      ],
    },
  },

  'alerta-cumplimiento': {
    clave: 'alerta-cumplimiento',
    titulo: 'Alerta de cumplimiento bajo el mínimo',
    cuando: 'Cuando una ronda cierra bajo el mínimo configurado. Va directo al administrador.',
    asunto: 'Cumplimiento bajo el mínimo — {{recinto}}: {{ruta}} ({{cumplimiento}}%)',
    contenido: {
      preheader: '{{cumplimiento}}% frente al mínimo de {{umbral}}%.',
      encabezado: 'Cumplimiento bajo el mínimo en {{recinto}}',
      parrafos: [
        'La ronda "{{ruta}}" del recinto {{recinto}} ({{sucursal}}) cerró con {{cumplimiento}}% de cumplimiento, bajo el mínimo de {{umbral}}% que definiste.',
        '{{adjunto}}',
      ],
      datos: [...DATOS_DE_RONDA],
      boton: null,
      enlaceVisible: null,
      notas: [
        'Recibes este aviso porque administras la empresa. El informe lista punto por punto cuáles quedaron sin marcar y a qué hora se marcó cada uno.',
        NOTA_HORAS,
      ],
    },
  },
};

export const FICHAS_PLANTILLA: readonly FichaPlantilla[] = CLAVES_PLANTILLA.map(
  (clave) => CATALOGO_PLANTILLAS[clave],
);

/**
 * La plantilla lista para el proveedor de correo.
 *
 * `incluirHtml` viene de la regla `mailIncludeHtml`. Apagado sale SOLO texto,
 * que es un correo completo y no uno mutilado: el texto tiene el mismo
 * contenido porque los dos salen de la misma declaracion.
 */
export function construirPlantilla(
  clave: ClavePlantilla,
  forma: FormaMarca,
  incluirHtml: boolean,
): MailTemplate {
  const ficha = CATALOGO_PLANTILLAS[clave];
  const texto = maquetaTexto(ficha.contenido, forma);
  if (!incluirHtml) return { subject: ficha.asunto, text: texto };
  return {
    subject: ficha.asunto,
    text: texto,
    html: maquetaHtml(ficha.contenido, forma),
  };
}

/** Los nombres de variable que una plantilla ya armada necesita para renderizar. */
export function marcadoresDe(plantilla: MailTemplate): string[] {
  const encontrados = new Set<string>();
  for (const parte of [plantilla.subject, plantilla.text, plantilla.html ?? '']) {
    for (const coincidencia of parte.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_.-]*)\s*\}\}/g)) {
      const nombre = coincidencia[1];
      if (nombre !== undefined) encontrados.add(nombre);
    }
  }
  return [...encontrados].sort();
}
