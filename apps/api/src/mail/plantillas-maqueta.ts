/**
 * La maqueta comun de los correos del producto (#42).
 *
 * UNA SOLA DECLARACION, DOS SALIDAS. El contenido se escribe una vez
 * (`ContenidoCorreo`) y de ahi salen el HTML y el texto plano. Es la unica
 * forma de que la version en texto no quede vieja: si alguien agrega un parrafo
 * al HTML, el texto lo tiene en el mismo commit porque es el mismo dato. El
 * issue pide "version texto plano de cada plantilla" y asi no depende de que
 * nadie se acuerde.
 *
 * POR QUE EL HTML SE VE COMO DE 2005
 * Outlook de escritorio no usa un motor de navegador: renderiza con el de Word.
 * Eso significa, en concreto:
 *   - No hay flexbox ni grid ni float confiable. La maqueta es de TABLAS.
 *   - `padding` funciona en `td`, no en `div`. Todo el espaciado va en celdas.
 *   - `max-width` se ignora: el ancho va en el atributo `width` ademas del
 *     estilo.
 *   - `background-color` en `style` se pierde seguido: se repite en `bgcolor`.
 *   - `mso-table-lspace/rspace` en 0 saca el espacio fantasma que Word agrega
 *     alrededor de cada tabla.
 *
 * Y Gmail: descarta el `<style>` del `<head>` en la app de Gmail cuando la
 * cuenta no es de Google. Por eso TODO lo indispensable esta en atributos
 * `style` en linea, y el bloque `<style>` lleva solo las media queries, que son
 * mejora y no requisito. En un telefono sin media queries el correo se ve
 * angosto pero entero, porque la caja de 600 px lleva ancho al 100%.
 *
 * `color-scheme: light` no es cosmetico: sin el, el modo oscuro de Outlook.com
 * y de Gmail invierte los colores por su cuenta y deja el texto del color de
 * marca ilegible sobre el fondo de marca.
 *
 * Nada de imagen de fondo, nada de fuente web: las bloquean o las ignoran, y el
 * correo tiene que leerse igual con las imagenes desactivadas, que es como lo
 * abre por defecto medio Outlook corporativo.
 */

/** Nombres de las variables de marca. El catalogo y el servicio usan estas. */
export const VAR_MARCA_NOMBRE = 'marcaNombre';
export const VAR_MARCA_COLOR = 'marcaColor';
export const VAR_MARCA_COLOR_TEXTO = 'marcaColorTexto';
export const VAR_MARCA_LOGO_SRC = 'marcaLogoSrc';
export const VAR_MARCA_LOGO_ANCHO = 'marcaLogoAncho';
export const VAR_MARCA_PIE = 'marcaPie';

const ANCHO_CAJA = 600;
const FUENTE = "Arial, Helvetica, sans-serif";
const GRIS_FONDO = '#f4f5f7';
const GRIS_TEXTO = '#333333';
const GRIS_SUAVE = '#6b7280';
const BORDE = '#e5e7eb';

export interface DatoCorreo {
  /** Texto fijo. Lo escribimos nosotros. */
  readonly etiqueta: string;
  /** Normalmente un marcador `{{...}}`. */
  readonly valor: string;
}

export interface BotonCorreo {
  readonly etiqueta: string;
  /** Marcador con el enlace. Se usa tal cual en el href. */
  readonly href: string;
}

export interface ContenidoCorreo {
  /**
   * La linea que Gmail y el correo del telefono muestran junto al asunto en la
   * lista. Sin esto, el cliente lee el principio del cuerpo, que en un correo
   * con logo arriba suele ser el nombre de la empresa repetido.
   */
  readonly preheader: string;
  readonly encabezado: string;
  readonly parrafos: readonly string[];
  readonly datos: readonly DatoCorreo[];
  readonly boton: BotonCorreo | null;
  /** El enlace en texto, para quien no puede apretar el boton. */
  readonly enlaceVisible: string | null;
  /** Letra chica del final: por que recibe esto, como cambiarlo. */
  readonly notas: readonly string[];
}

export interface FormaMarca {
  readonly conLogo: boolean;
  readonly conPie: boolean;
}

export function maquetaHtml(contenido: ContenidoCorreo, forma: FormaMarca): string {
  const lineas: string[] = [];

  lineas.push('<!DOCTYPE html>');
  lineas.push('<html lang="es">');
  lineas.push('<head>');
  lineas.push('<meta http-equiv="Content-Type" content="text/html; charset=UTF-8">');
  lineas.push('<meta name="viewport" content="width=device-width, initial-scale=1">');
  lineas.push('<meta name="x-apple-disable-message-reformatting">');
  lineas.push('<meta name="color-scheme" content="light">');
  lineas.push('<meta name="supported-color-schemes" content="light">');
  lineas.push(`<title>{{${VAR_MARCA_NOMBRE}}}</title>`);
  lineas.push('<!--[if mso]>');
  lineas.push('<style type="text/css">');
  lineas.push(`body, table, td, a { font-family: ${FUENTE} !important; }`);
  lineas.push('</style>');
  lineas.push('<![endif]-->');
  lineas.push('<style type="text/css">');
  lineas.push('@media only screen and (max-width: 620px) {');
  lineas.push('  .caja { width: 100% !important; }');
  lineas.push('  .pad { padding-left: 20px !important; padding-right: 20px !important; }');
  lineas.push('  .boton a { display: block !important; }');
  lineas.push('}');
  lineas.push('</style>');
  lineas.push('</head>');
  lineas.push(
    `<body style="margin:0; padding:0; width:100%; background-color:${GRIS_FONDO};` +
      ' -webkit-text-size-adjust:100%; -ms-text-size-adjust:100%;">',
  );

  // Preheader oculto. El relleno invisible del final evita que el cliente siga
  // leyendo del cuerpo y muestre medio parrafo pegado en la lista.
  lineas.push(
    '<div style="display:none; font-size:1px; line-height:1px; max-height:0; max-width:0;' +
      ' opacity:0; overflow:hidden; mso-hide:all;">' +
      literal(contenido.preheader) +
      '&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;' +
      '</div>',
  );

  lineas.push(
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"` +
      ` style="background-color:${GRIS_FONDO}; mso-table-lspace:0pt; mso-table-rspace:0pt;">`,
  );
  lineas.push('<tr>');
  lineas.push('<td align="center" style="padding:24px 12px;">');
  lineas.push(
    `<table role="presentation" class="caja" width="${ANCHO_CAJA}" cellpadding="0"` +
      ` cellspacing="0" border="0" style="width:${ANCHO_CAJA}px; max-width:${ANCHO_CAJA}px;` +
      ' background-color:#ffffff; border-radius:6px;' +
      ' mso-table-lspace:0pt; mso-table-rspace:0pt;">',
  );

  lineas.push(...cabecera(forma));
  lineas.push(...cuerpo(contenido));
  lineas.push(...pie(contenido, forma));

  lineas.push('</table>');
  lineas.push('</td>');
  lineas.push('</tr>');
  lineas.push('</table>');
  lineas.push('</body>');
  lineas.push('</html>');

  return lineas.join('\n');
}

function cabecera(forma: FormaMarca): string[] {
  const contenido = forma.conLogo
    ? `<img src="{{${VAR_MARCA_LOGO_SRC}}}" width="{{${VAR_MARCA_LOGO_ANCHO}}}"` +
      ` alt="{{${VAR_MARCA_NOMBRE}}}" style="display:block; border:0; outline:none;` +
      ` text-decoration:none; height:auto; width:{{${VAR_MARCA_LOGO_ANCHO}}}px;">`
    : `<span style="font-family:${FUENTE}; font-size:20px; font-weight:bold;` +
      ` color:{{${VAR_MARCA_COLOR_TEXTO}}};">{{${VAR_MARCA_NOMBRE}}}</span>`;

  return [
    '<tr>',
    `<td class="pad" align="left" bgcolor="{{${VAR_MARCA_COLOR}}}"` +
      ` style="background-color:{{${VAR_MARCA_COLOR}}}; padding:20px 32px;` +
      ' border-radius:6px 6px 0 0;">',
    contenido,
    '</td>',
    '</tr>',
  ];
}

function cuerpo(contenido: ContenidoCorreo): string[] {
  const lineas: string[] = [];
  lineas.push('<tr>');
  lineas.push('<td class="pad" align="left" style="padding:28px 32px 8px 32px;">');
  lineas.push(
    `<h1 style="margin:0 0 16px 0; font-family:${FUENTE}; font-size:22px;` +
      ` line-height:28px; font-weight:bold; color:#111111;">${literal(contenido.encabezado)}</h1>`,
  );

  for (const parrafo of contenido.parrafos) {
    lineas.push(
      `<p style="margin:0 0 14px 0; font-family:${FUENTE}; font-size:15px;` +
        ` line-height:23px; color:${GRIS_TEXTO};">${literal(parrafo)}</p>`,
    );
  }
  lineas.push('</td>');
  lineas.push('</tr>');

  if (contenido.datos.length > 0) {
    lineas.push('<tr>');
    lineas.push('<td class="pad" align="left" style="padding:4px 32px 8px 32px;">');
    lineas.push(
      '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"' +
        ` style="border:1px solid ${BORDE}; border-radius:4px;` +
        ' mso-table-lspace:0pt; mso-table-rspace:0pt;">',
    );
    for (const dato of contenido.datos) {
      lineas.push('<tr>');
      lineas.push(
        `<td align="left" style="padding:9px 14px; font-family:${FUENTE}; font-size:13px;` +
          ` line-height:18px; color:${GRIS_SUAVE}; white-space:nowrap;">` +
          `${literal(dato.etiqueta)}</td>`,
      );
      lineas.push(
        `<td align="right" style="padding:9px 14px; font-family:${FUENTE}; font-size:14px;` +
          ` line-height:18px; color:#111111; font-weight:bold;">${valor(dato.valor)}</td>`,
      );
      lineas.push('</tr>');
    }
    lineas.push('</table>');
    lineas.push('</td>');
    lineas.push('</tr>');
  }

  if (contenido.boton) {
    lineas.push('<tr>');
    lineas.push('<td class="pad" align="left" style="padding:16px 32px 8px 32px;">');
    lineas.push(
      '<table role="presentation" class="boton" cellpadding="0" cellspacing="0" border="0"' +
        ' style="mso-table-lspace:0pt; mso-table-rspace:0pt;">',
    );
    lineas.push('<tr>');
    lineas.push(
      `<td align="center" bgcolor="{{${VAR_MARCA_COLOR}}}"` +
        ` style="background-color:{{${VAR_MARCA_COLOR}}}; border-radius:4px;">`,
    );
    lineas.push(
      `<a href="${valor(contenido.boton.href)}" target="_blank"` +
        ` style="display:inline-block; padding:13px 26px; font-family:${FUENTE};` +
        ' font-size:16px; line-height:20px; font-weight:bold;' +
        ` color:{{${VAR_MARCA_COLOR_TEXTO}}}; text-decoration:none;">` +
        `${literal(contenido.boton.etiqueta)}</a>`,
    );
    lineas.push('</td>');
    lineas.push('</tr>');
    lineas.push('</table>');
    lineas.push('</td>');
    lineas.push('</tr>');
  }

  if (contenido.enlaceVisible) {
    lineas.push('<tr>');
    lineas.push('<td class="pad" align="left" style="padding:8px 32px 8px 32px;">');
    lineas.push(
      `<p style="margin:0; font-family:${FUENTE}; font-size:12px; line-height:18px;` +
        ` color:${GRIS_SUAVE}; word-break:break-all;">` +
        `${literal('Si el boton no funciona, copia y pega este enlace:')}<br>` +
        `${valor(contenido.enlaceVisible)}</p>`,
    );
    lineas.push('</td>');
    lineas.push('</tr>');
  }

  return lineas;
}

function pie(contenido: ContenidoCorreo, forma: FormaMarca): string[] {
  const lineas: string[] = [];
  if (contenido.notas.length === 0 && !forma.conPie) return lineas;

  lineas.push('<tr>');
  lineas.push(
    `<td class="pad" align="left" style="padding:16px 32px 26px 32px;` +
      ` border-top:1px solid ${BORDE};">`,
  );
  for (const nota of contenido.notas) {
    lineas.push(
      `<p style="margin:0 0 8px 0; font-family:${FUENTE}; font-size:12px;` +
        ` line-height:18px; color:${GRIS_SUAVE};">${literal(nota)}</p>`,
    );
  }
  if (forma.conPie) {
    lineas.push(
      `<p style="margin:8px 0 0 0; font-family:${FUENTE}; font-size:12px;` +
        ` line-height:18px; color:${GRIS_SUAVE};">{{${VAR_MARCA_PIE}}}</p>`,
    );
  }
  lineas.push('</td>');
  lineas.push('</tr>');
  return lineas;
}

/** La version en texto plano del MISMO contenido. */
export function maquetaTexto(contenido: ContenidoCorreo, forma: FormaMarca): string {
  const bloques: string[] = [];

  bloques.push(`{{${VAR_MARCA_NOMBRE}}}`);
  bloques.push(contenido.encabezado);
  if (contenido.parrafos.length > 0) bloques.push(contenido.parrafos.join('\n\n'));

  if (contenido.datos.length > 0) {
    bloques.push(contenido.datos.map((dato) => `${dato.etiqueta}: ${dato.valor}`).join('\n'));
  }

  // En texto no hay boton: el enlace se escribe completo y en su propia linea,
  // que es lo que los clientes convierten en enlace apretable.
  if (contenido.boton) {
    bloques.push(`${contenido.boton.etiqueta}:\n${contenido.boton.href}`);
  } else if (contenido.enlaceVisible) {
    bloques.push(contenido.enlaceVisible);
  }

  if (contenido.notas.length > 0) bloques.push(contenido.notas.join('\n\n'));
  if (forma.conPie) bloques.push(`--\n{{${VAR_MARCA_PIE}}}`);

  return bloques.join('\n\n');
}

/**
 * Escapa el texto que escribimos nosotros, dejando intactos los `{{marcadores}}`.
 *
 * Los VALORES los escapa el renderer (template-renderer.ts) al sustituir. Esto
 * es para la copia fija: si manana alguien escribe un parrafo con un signo de
 * mayor que, no se lo come el HTML.
 */
function literal(texto: string): string {
  return texto.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Un valor dinamico. Si viene como marcador se deja intacto —lo sustituye y lo
 * escapa el renderer—; cualquier otra cosa se escapa aca mismo.
 */
function valor(texto: string): string {
  return /^\{\{[a-zA-Z][a-zA-Z0-9_.-]*\}\}$/.test(texto) ? texto : literal(texto);
}
