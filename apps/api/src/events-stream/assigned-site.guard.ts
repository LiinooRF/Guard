import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { EventsStreamService } from './events-stream.service';

interface PeticionAutenticada extends Request {
  user?: AuthenticatedUser;
}

/**
 * Alcance por recinto para el endpoint SSE.
 *
 * Va en un guard y no dentro del handler porque el guard corre ANTES de que Nest
 * empiece a responder: un recinto ajeno se rechaza con un 403 HTTP limpio, que
 * es lo que hace que el EventSource del navegador deje de reintentar. Un rechazo
 * emitido ya dentro del flujo depende de que el error ocurra antes del primer
 * mensaje para poder cambiar el codigo de estado.
 *
 * El AuthGuard global ya corrio y dejo `request.user`: aca solo se resuelve la
 * restriccion extra del SUPERVISOR, que no se cubre con el permiso.
 */
@Injectable()
export class AssignedSiteGuard implements CanActivate {
  constructor(private readonly bandeja: EventsStreamService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<PeticionAutenticada>();
    const user = request.user;
    if (!user?.sub || !user.tenant_id) {
      throw new ForbiddenException('La operación requiere contexto de empresa');
    }

    // Express tipa los params como string | string[]: un parametro repetido en
    // la URL llega como arreglo y no puede pasar como identificador.
    const siteId = request.params?.siteId;
    if (typeof siteId !== 'string' || !isUUID(siteId)) {
      throw new BadRequestException('El recinto no es un identificador válido');
    }

    await this.bandeja.ensureAssignedSite(user.tenant_id, user.sub, siteId);
    return true;
  }
}
