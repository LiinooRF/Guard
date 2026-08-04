import { z, type ZodIssue } from 'zod';

/**
 * Los dos parametros de negocio que este issue agrega a rules.ts.
 *
 * POR QUE ESTAN ACA Y NO IMPORTADOS DE @voxia/shared: `rules.ts` es un archivo
 * que este entregable no puede tocar. El zod exacto y la ficha de catalogo de
 * `mailIncludeHtml` y `mailLogoMaxKB` estan escritos en INTEGRACION.md y los
 * aplica el integrador.
 *
 * Mientras tanto este modulo NO inventa un default. Si las claves no llegan,
 * lanza nombrando el archivo de integracion. Un default silencioso aca seria
 * exactamente el numero de negocio fijo en el codigo que la regla 3 prohibe, y
 * ademas escondaria una integracion a medias hasta que un cliente reciba un
 * correo sin marca.
 *
 * ACA SE COMPRUEBA PRESENCIA Y TIPO, NO EL RANGO. El rango de un parametro de
 * negocio tiene un solo dueño y es `rules.ts`, que ademas es el que el admin
 * edita. Repetir el `.min(1).max(1024)` aca creaba una segunda fuente de verdad
 * del mismo numero: si alguien sube el tope de rules.ts a 2048 y el admin
 * guarda 1500, la regla existe y es valida, pero este safeParse fallaba y el
 * correo dejaba de salir con un error que apunta al lugar equivocado ("faltan
 * los parametros" cuando estan puestos).
 */
export const opcionesCorreoSchema = z.object({
  /**
   * Si el correo sale con cuerpo HTML ademas del texto plano. Apagado, sale
   * SOLO texto: sigue siendo un correo completo y legible, no uno mutilado.
   * Existe porque hay Outlook corporativos con politicas que rompen el HTML, y
   * porque un tenant puede preferir el texto por peso.
   *
   * NO es "mandar o no mandar el correo": el correo sale igual en los dos casos.
   */
  mailIncludeHtml: z.boolean(),

  /**
   * Peso maximo del LOGO que viaja incrustado en cada correo, en kilobytes.
   * Sobre esto el correo sale con el nombre de la empresa en texto en vez del
   * logo, que se lee igual y no infla cada mensaje.
   *
   * NO confundir con `reportMailMaxAttachmentMB`, que es el tope del INFORME PDF
   * adjunto y se mide en megabytes. Son dos limites distintos sobre dos cosas
   * distintas del mismo correo.
   *
   * `positive()` y no `.min(1).max(1024)`: el rango lo define y lo valida
   * rules.ts. Lo unico que este modulo necesita saber es que llego un entero
   * con el que se puede comparar un peso en bytes; un 0 o un negativo apagarian
   * el logo de todos los correos sin decir por que.
   */
  mailLogoMaxKB: z.number().int().positive(),
});

export interface OpcionesCorreo {
  readonly incluirHtml: boolean;
  readonly logoMaxKB: number;
}

/**
 * Saca las dos claves del objeto de reglas efectivas ya resuelto por la cascada.
 *
 * Recibe `unknown` a proposito: el tipo `PatrolRules` todavia no las declara y
 * un cast optimista dejaria pasar `undefined` hasta el render.
 */
export function opcionesDesdeReglas(reglas: unknown): OpcionesCorreo {
  const parsed = opcionesCorreoSchema.safeParse(reglas);
  if (!parsed.success) {
    // Dos fallas distintas y dos mensajes distintos. "La clave no llego" es una
    // integracion a medias y se arregla en rules.ts; "llego con un valor que no
    // entiendo" es un dato malo y se arregla en el dato. Un solo mensaje para
    // las dos manda a quien depura al archivo equivocado.
    const ausentes = parsed.error.issues.filter(
      (issue) => issue.code === 'invalid_type' && issue.received === 'undefined',
    );
    if (ausentes.length > 0) {
      throw new Error(
        `Faltan los parametros de correo en rules.ts (${ausentes.map(nombreDeIssue).join(', ')}). ` +
          'Estan escritos, con su zod y su ficha de catalogo, en INTEGRACION.md del issue #42.',
      );
    }
    throw new Error(
      'Los parametros de correo de rules.ts llegaron con un valor que no entiendo: ' +
        parsed.error.issues
          .map((issue) => `${nombreDeIssue(issue)} ${issue.message}`)
          .join('; ') +
        '. El rango de cada uno lo define rules.ts; aca solo se comprueba presencia y tipo.',
    );
  }
  return {
    incluirHtml: parsed.data.mailIncludeHtml,
    logoMaxKB: parsed.data.mailLogoMaxKB,
  };
}

/** El nombre de la clave que fallo. Sin ruta es el objeto de reglas completo. */
function nombreDeIssue(issue: ZodIssue): string {
  return issue.path.length > 0 ? issue.path.join('.') : 'el objeto de reglas completo';
}
