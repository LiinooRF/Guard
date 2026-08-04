import { Body, Controller, Get, Put } from '@nestjs/common';

import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { RulesService } from '../rules/rules.service';
import { CLAVES_PLANTILLA, CATALOGO_PLANTILLAS } from './plantillas-catalogo';
import { PlantillasCorreoService } from './plantillas-correo.service';
import { variablesDeEjemplo } from './plantillas-ejemplo';
import { PlantillasMarcaService } from './plantillas-marca';
import { opcionesDesdeReglas } from './plantillas-opciones';
import { remitenteTenantSchema } from './plantillas-remitente.dto';
import { PlantillasRemitenteService } from './plantillas-remitente.service';
import { construirSobre } from './plantillas-sobre';
import { renderTemplate } from './template-renderer';

/**
 * Configuracion del correo de la empresa y vista previa de las plantillas (#42).
 *
 * TODO ESTO ES SOLO DEL ADMIN: `tenant:rules:manage` es un permiso que hoy solo
 * tiene ADMIN (ver ROLE_PERMISSIONS). El SUPERVISOR queda fuera y no hace falta
 * chequear recintos asignados, porque no hay nada por recinto que mirar: el
 * remitente es de la empresa completa. Si algun dia se abriera al SUPERVISOR,
 * habria que agregar el filtro por supervisor_sites, que el rol NO alcanza.
 *
 * La vista previa existe por el criterio de aceptacion "se ven bien en Gmail,
 * Outlook y en movil": sin una forma de mirar el correo antes de mandarlo, la
 * unica manera de revisarlo es esperar a que cierre una ronda de verdad.
 */
@Controller('mail')
export class PlantillasCorreoController {
  constructor(
    private readonly remitente: PlantillasRemitenteService,
    private readonly plantillas: PlantillasCorreoService,
    private readonly marca: PlantillasMarcaService,
    private readonly rules: RulesService,
  ) {}

  @Get('remitente')
  @Permissions('tenant:rules:manage')
  @TenantScope()
  async verRemitente() {
    const opciones = opcionesDesdeReglas(await this.rules.effective());
    return this.remitente.actual(opciones.logoMaxKB);
  }

  @Put('remitente')
  @Permissions('tenant:rules:manage')
  @TenantScope()
  async guardarRemitente(@Body() input: unknown) {
    // El DTO ES el contrato, igual que en branding: un campo desconocido es un
    // 400 y no un dato que se pierde en silencio.
    const datos = remitenteTenantSchema.parse(input ?? {});
    const opciones = opcionesDesdeReglas(await this.rules.effective());
    return this.remitente.guardar(datos, opciones.logoMaxKB);
  }

  /**
   * Las cuatro plantillas renderizadas con la marca real de la empresa y datos
   * de ejemplo. El panel las pinta en un iframe aislado.
   *
   * El logo viaja como data URI y no como `cid:` porque esto lo abre un
   * navegador, no un cliente de correo. Es la unica diferencia con lo que se
   * envia de verdad, y esta acotada a esta ruta.
   */
  @Get('plantillas')
  @Permissions('tenant:rules:manage')
  @TenantScope()
  async vistaPrevia() {
    const opciones = opcionesDesdeReglas(await this.rules.effective());
    const marca = await this.marca.resolver(opciones.logoMaxKB);

    const plantillas = CLAVES_PLANTILLA.map((clave) => {
      const armado = this.plantillas.armarConMarca(
        clave,
        variablesDeEjemplo(clave),
        opciones,
        marca,
        'vista-previa',
      );
      const renderizado = renderTemplate(armado.template, armado.variables);
      return {
        clave,
        titulo: CATALOGO_PLANTILLAS[clave].titulo,
        cuando: CATALOGO_PLANTILLAS[clave].cuando,
        asunto: renderizado.subject,
        texto: renderizado.text,
        html: renderizado.html ?? null,
      };
    });

    const sobre = construirSobre(marca, this.marca.remitenteDeLaPlataforma());

    return {
      remitente: {
        from: sobre.from,
        replyTo: sobre.replyTo ?? null,
        incluyeHtml: opciones.incluirHtml,
      },
      marca: {
        nombreEmpresa: marca.nombreEmpresa,
        nombreRemitente: marca.nombreRemitente,
        colorPrimario: marca.colorPrimario,
        conLogo: marca.logo !== null,
        motivoSinLogo: marca.motivoSinLogo,
        conPie: marca.pie !== null,
      },
      plantillas,
    };
  }
}
