import { Injectable } from '@nestjs/common';

import type { MailAttachment, MailTemplate, MailTemplateVariables } from './mail-provider';
import {
  construirPlantilla,
  marcadoresDe,
  type ClavePlantilla,
} from './plantillas-catalogo';
import { LOGO_CONTENT_ID } from './plantillas-logo';
import {
  VAR_MARCA_COLOR,
  VAR_MARCA_COLOR_TEXTO,
  VAR_MARCA_LOGO_ANCHO,
  VAR_MARCA_LOGO_SRC,
  VAR_MARCA_NOMBRE,
  VAR_MARCA_PIE,
  type FormaMarca,
} from './plantillas-maqueta';
import { PlantillasMarcaService, type MarcaCorreo } from './plantillas-marca';
import type { OpcionesCorreo } from './plantillas-opciones';
import { construirSobre, type SobreCorreo } from './plantillas-sobre';

/**
 * Arma el correo completo de un tenant: plantilla, variables, logo y sobre (#42).
 *
 * SE LLAMA AL ENCOLAR, NUNCA EN EL WORKER. La marca se resuelve consultando la
 * base con RLS, y el worker de la cola (mail.processor.ts) corre fuera de
 * cualquier transaccion con `app.tenant_id`: si se resolviera alli, la consulta
 * no veria nada y todos los correos saldrian con la marca de la plataforma. Por
 * eso el sobre y las variables ya resueltas VIAJAN dentro del job.
 *
 * Y ADEMAS SE VALIDA AL ENCOLAR. `renderTemplate` lanza cuando falta una
 * variable, pero lo hace dentro del worker: alli la falla es un job muerto que
 * alguien tiene que ir a mirar. Verificarlo aca convierte ese silencio en un
 * error inmediato, en el request que lo provoco. Un correo de alerta que no
 * sale es peor que uno feo.
 */

/**
 * Adjunto en linea. `cid` es lo que hace que `<img src="cid:...">` muestre el
 * logo en Gmail y en Outlook; el data URI no lo muestra ninguno de los dos.
 *
 * REQUIERE el campo `cid` en MailAttachment y su paso a nodemailer. Es un
 * cambio de tres lineas en archivos que este entregable no toca; esta escrito
 * en INTEGRACION.md. Sin el, `armar()` sigue funcionando: basta pedirlo con
 * `conLogo` apagado y el correo sale con el nombre de la empresa en texto.
 */
export interface AdjuntoEnLinea extends MailAttachment {
  readonly cid: string;
}

export interface CorreoArmado {
  readonly template: MailTemplate;
  readonly variables: MailTemplateVariables;
  /** Vacio salvo que el logo viaje incrustado. */
  readonly attachments: readonly AdjuntoEnLinea[];
  readonly envelope: SobreCorreo;
  readonly marca: MarcaCorreo;
}

/** A donde va el correo armado. La vista previa del panel no usa `cid:`. */
export type DestinoRender = 'correo' | 'vista-previa';

export interface DatosEnlace {
  /** El enlace con el token. NUNCA se registra en un log. */
  readonly enlace: string;
  /** Cuanto dura, escrito para una persona: "24 horas", "30 minutos". */
  readonly vigencia: string;
}

@Injectable()
export class PlantillasCorreoService {
  constructor(private readonly marca: PlantillasMarcaService) {}

  invitacion(datos: DatosEnlace, opciones: OpcionesCorreo): Promise<CorreoArmado> {
    return this.armar('invitacion', variablesDeEnlace(datos), opciones);
  }

  recuperacion(datos: DatosEnlace, opciones: OpcionesCorreo): Promise<CorreoArmado> {
    return this.armar('recuperacion', variablesDeEnlace(datos), opciones);
  }

  /**
   * Recuperacion SIN contexto de tenant: sale con la marca de la plataforma.
   *
   * Es el ultimo recurso, para cuando `lookup_recovery_identity` no devuelve
   * tenant (una cuenta de plataforma, por ejemplo). Si hay tenant, el camino
   * correcto es abrir contexto con PlantillasContextoService y usar
   * `recuperacion()`: un correo con la marca equivocada, en un producto
   * white-label, es el cliente viendo la marca de otro.
   */
  recuperacionDePlataforma(datos: DatosEnlace, opciones: OpcionesCorreo): CorreoArmado {
    return this.armarConMarca(
      'recuperacion',
      variablesDeEnlace(datos),
      opciones,
      this.marca.deLaPlataforma(),
    );
  }

  /**
   * Informe de cierre de ronda. Recibe tal cual el resultado de
   * `variablesInforme()` de reports/envio-informe.plantillas.ts: los nombres de
   * variable son los mismos de siempre y no hay que tocar ese calculo.
   */
  informeDeRonda(
    variables: MailTemplateVariables,
    opciones: OpcionesCorreo,
  ): Promise<CorreoArmado> {
    return this.armar('informe-ronda', variables, opciones);
  }

  /** La alerta bajo el minimo. Mismas variables que el informe, otro asunto. */
  alertaDeCumplimiento(
    variables: MailTemplateVariables,
    opciones: OpcionesCorreo,
  ): Promise<CorreoArmado> {
    return this.armar('alerta-cumplimiento', variables, opciones);
  }

  async armar(
    clave: ClavePlantilla,
    propias: MailTemplateVariables,
    opciones: OpcionesCorreo,
    destino: DestinoRender = 'correo',
  ): Promise<CorreoArmado> {
    const marca = await this.marca.resolver(opciones.logoMaxKB);
    return this.armarConMarca(clave, propias, opciones, marca, destino);
  }

  armarConMarca(
    clave: ClavePlantilla,
    propias: MailTemplateVariables,
    opciones: OpcionesCorreo,
    marca: MarcaCorreo,
    destino: DestinoRender = 'correo',
  ): CorreoArmado {
    // Sin HTML no hay donde poner el logo: un adjunto suelto que nadie muestra
    // solo agrega peso al correo y una miniatura desconcertante.
    const forma: FormaMarca = {
      conLogo: opciones.incluirHtml && marca.logo !== null,
      conPie: marca.pie !== null,
    };

    const template = construirPlantilla(clave, forma, opciones.incluirHtml);
    const variables: MailTemplateVariables = {
      ...propias,
      ...variablesDeMarca(marca, forma, destino),
    };

    verificarVariables(clave, template, variables);

    return {
      template,
      variables,
      attachments: adjuntosDeMarca(marca, forma, destino),
      envelope: construirSobre(marca, this.marca.remitenteDeLaPlataforma()),
      marca,
    };
  }
}

function variablesDeEnlace(datos: DatosEnlace): MailTemplateVariables {
  return { enlace: datos.enlace, vigencia: datos.vigencia };
}

function variablesDeMarca(
  marca: MarcaCorreo,
  forma: FormaMarca,
  destino: DestinoRender,
): MailTemplateVariables {
  const variables: Record<string, string | number> = {
    [VAR_MARCA_NOMBRE]: marca.nombreEmpresa,
    [VAR_MARCA_COLOR]: marca.colorPrimario,
    [VAR_MARCA_COLOR_TEXTO]: marca.colorTextoSobrePrimario,
  };

  if (forma.conPie && marca.pie !== null) variables[VAR_MARCA_PIE] = marca.pie;

  if (forma.conLogo && marca.logo !== null) {
    variables[VAR_MARCA_LOGO_ANCHO] = marca.logo.anchoPx;
    variables[VAR_MARCA_LOGO_SRC] =
      marca.logo.modo === 'url'
        ? marca.logo.url
        : // En el correo va el Content-ID; en la vista previa del panel va el
          // data URI, que el navegador si dibuja y el cliente de correo no.
          destino === 'correo'
          ? `cid:${LOGO_CONTENT_ID}`
          : marca.logo.dataUri;
  }

  return variables;
}

function adjuntosDeMarca(
  marca: MarcaCorreo,
  forma: FormaMarca,
  destino: DestinoRender,
): readonly AdjuntoEnLinea[] {
  if (destino !== 'correo') return [];
  if (!forma.conLogo || marca.logo === null || marca.logo.modo !== 'incrustado') return [];
  return [
    {
      filename: marca.logo.filename,
      contentType: marca.logo.contentType,
      contentBase64: marca.logo.contentBase64,
      cid: LOGO_CONTENT_ID,
    },
  ];
}

/**
 * Que no falte ninguna variable, con el nombre de la plantilla en el mensaje.
 *
 * No se registran los valores: por aca pasan enlaces con token de invitacion y
 * de recuperacion, y el correo de la persona.
 */
export function verificarVariables(
  clave: ClavePlantilla,
  template: MailTemplate,
  variables: MailTemplateVariables,
): void {
  const faltantes = marcadoresDe(template).filter((nombre) => {
    const valor = variables[nombre];
    return valor === undefined || valor === null;
  });
  if (faltantes.length === 0) return;
  throw new Error(
    `La plantilla de correo "${clave}" quedaria sin renderizar: faltan las variables ` +
      faltantes.join(', '),
  );
}
