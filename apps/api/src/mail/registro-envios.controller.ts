import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { TenantScope } from '../auth/decorators/tenant-scope.decorator';
import { RegistroEnviosQuery, RondaParam } from './registro-envios.dto';
import { RegistroEnviosService } from './registro-envios.service';

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * Vista de soporte del registro de envios (#44).
 *
 * ES DE SOLO LECTURA, y no por falta de tiempo. No existe "reenviar" ni "marcar
 * como entregado": el estado lo escriben la cola y el proveedor, y un boton que
 * deje escribirlo a mano convierte la auditoria en una opinion. Si un correo hay
 * que mandarlo de nuevo, eso es una accion del carril que lo origina, no de su
 * bitacora.
 *
 * DOS PERMISOS DISTINTOS, A PROPOSITO
 *   - `porRonda` responde "¿le llego el informe de esta ronda al cliente?" y va
 *     con `reports:read`, igual que el resto de lo que se consulta de una ronda.
 *     El SUPERVISOR entra, acotado a sus recintos asignados.
 *   - `listar` muestra TODO el correo de la empresa, invitaciones y
 *     recuperaciones de clave incluidas. Eso ya no es un informe de ronda: es
 *     auditoria del tenant, va con `tenant:audit:read` y queda solo para el
 *     ADMIN. Darle esta lista al SUPERVISOR le mostraria a que correos se
 *     invito gente de recintos que no supervisa.
 */
@Controller('notif')
@TenantScope()
export class RegistroEnviosController {
  constructor(private readonly registro: RegistroEnviosService) {}

  /**
   * Que correos salieron por esta ronda y en que quedaron.
   *
   * El alcance del SUPERVISOR se verifica en el servicio contra
   * supervisor_sites: el permiso `reports:read` por si solo no alcanza.
   */
  @Get('rondas/:patrolId/envios')
  @Permissions('reports:read')
  async porRonda(@Param() params: RondaParam, @Req() request: Autenticado) {
    return this.registro.porRonda(params.patrolId, request.user);
  }

  /** El registro de correo de la empresa, con filtros. */
  @Get('envios')
  @Permissions('tenant:audit:read')
  async listar(@Query() query: RegistroEnviosQuery) {
    return this.registro.listar({
      siteId: query.siteId ?? null,
      estado: query.estado ?? null,
      plantilla: query.plantilla ?? null,
      desde: query.desde ?? null,
      hasta: query.hasta ?? null,
      limite: query.limite ?? null,
    });
  }
}
