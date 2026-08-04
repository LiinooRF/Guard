import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Logger,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Public } from '../auth/decorators/public.decorator';
import { SkipTenantContext } from '../database/tenant-context/skip-tenant-context.decorator';
import { WEBHOOK_SECRET_ENV } from './registro-envios.constants';
import { EstadoEntregaDto } from './registro-envios.dto';
import { verificarFirma } from './registro-envios.firma';
import { RegistroEnviosService } from './registro-envios.service';

/**
 * Ingesta del estado de entrega que reporta el proveedor de correo (#44).
 *
 * VA EN SU PROPIO CONTROLADOR, como PhotoServingController, porque su politica
 * es la contraria a la del resto del modulo: aquel es `@TenantScope()` con
 * sesion, y este no puede serlo. Quien llama es una maquina sin sesion y sin
 * tenant; lo que autoriza es la FIRMA, y el contexto de tenant lo pone el
 * servicio desde el indice de correlacion, nunca desde un campo del cuerpo.
 *
 * QUE NO ES: el webhook de un proveedor concreto. El proveedor de correo es la
 * decision abierta #9 y este issue no la cierra. Esto es el contrato interno de
 * ingesta; el traductor del proveedor elegido se escribe cuando #9 se cierre y
 * es lo unico que hay que cambiar entonces.
 *
 * NO CONFIRMA NI DESMIENTE QUE EL MENSAJE EXISTA. Un Message-ID desconocido y
 * uno de otra empresa responden lo mismo: 202 con `aplicado: false`. Distinguir
 * los casos convertiria el endpoint en un oraculo para adivinar identificadores.
 * El motivo queda en el log del servidor, que es donde soporte lo necesita.
 */
@Controller('notif/proveedor')
export class RegistroEnviosProveedorController {
  private readonly logger = new Logger(RegistroEnviosProveedorController.name);

  constructor(
    private readonly registro: RegistroEnviosService,
    private readonly config: ConfigService,
  ) {}

  @Post('estado')
  @Public()
  @SkipTenantContext()
  // 202: se recibio y se proceso lo que correspondia. No es 201 porque no crea
  // nada, y no es 200 porque el efecto puede ser ninguno legitimamente.
  @HttpCode(202)
  async estadoEntrega(@Body() cuerpo: EstadoEntregaDto) {
    const secreto = this.config.get<string>(WEBHOOK_SECRET_ENV);
    const veredicto = verificarFirma(
      secreto,
      {
        messageId: cuerpo.messageId,
        evento: cuerpo.evento,
        timestamp: cuerpo.timestamp,
        firma: cuerpo.firma,
      },
      Date.now(),
    );

    if (!veredicto.valido) {
      if (veredicto.motivo === 'sin_secreto') {
        // Falla CERRADA. Sin secreto configurado el canal no existe; aceptar
        // cualquier cuerpo dejaria a cualquiera escribir el estado de entrega
        // de una empresa que no es suya.
        this.logger.error(
          JSON.stringify({ event: 'webhook_entrega_sin_secreto', variable: WEBHOOK_SECRET_ENV }),
        );
        throw new ServiceUnavailableException('El canal de estados de entrega no está habilitado');
      }
      this.logger.warn(
        JSON.stringify({ event: 'webhook_entrega_rechazado', motivo: veredicto.motivo }),
      );
      throw new ForbiddenException('Firma de webhook inválida');
    }

    const resultado = await this.registro.aplicarEventoProveedor({
      messageId: cuerpo.messageId,
      evento: cuerpo.evento,
      // El instante lo firma el traductor y ya paso la ventana de frescura.
      ocurridoEn: new Date(cuerpo.timestamp * 1000),
      motivo: cuerpo.motivo ?? null,
    });

    if (!resultado.aplicado) {
      // Sin Message-ID ni correo: por que no se aplico, y nada mas.
      this.logger.log(
        JSON.stringify({ event: 'webhook_entrega_ignorado', motivo: resultado.ignorado }),
      );
    }

    return { aplicado: resultado.aplicado };
  }
}
