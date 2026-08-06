import {
  Body,
  Controller,
  ForbiddenException,
  Headers,
  HttpCode,
  Inject,
  Logger,
  Post,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';

import { Public } from '../auth/decorators/public.decorator';
import { SkipTenantContext } from '../database/tenant-context/skip-tenant-context.decorator';
import { WEBHOOK_SECRET_ENV } from './registro-envios.constants';
import { RegistroEnviosService } from './registro-envios.service';
import { TRADUCTOR_WEBHOOK, type TraductorWebhookCorreo } from './registro-envios.traductor';
import type { MotivoIgnorado } from './registro-envios.types';

/**
 * Ingesta del estado de entrega que reporta el proveedor de correo (#44, #220).
 *
 * VA EN SU PROPIO CONTROLADOR, como PhotoServingController, porque su politica
 * es la contraria a la del resto del modulo: aquel es `@TenantScope()` con
 * sesion, y este no puede serlo. Quien llama es una maquina sin sesion y sin
 * tenant; lo que autoriza es la FIRMA, y el contexto de tenant lo pone el
 * servicio desde el indice de correlacion, nunca desde un campo del cuerpo.
 *
 * NO CONOCE NINGUN FORMATO, Y ESO ES EL ISSUE #220. El cuerpo entra como
 * `unknown` y quien lo interpreta —y quien verifica la firma, que cada proveedor
 * hace a su manera— es `TraductorWebhookCorreo`. El proveedor de correo es la
 * decision abierta #9: el dia que se cierre se agrega un traductor y este
 * archivo no cambia. Mismo patron que `MailProvider` y `PushProvider`.
 *
 * EL CUERPO SE RECIBE COMO `unknown` A PROPOSITO. El ValidationPipe global corre
 * con `forbidNonWhitelisted: true`, asi que un DTO rechazaria con 400 cualquier
 * campo de mas —y los proveedores siempre mandan campos de mas— antes de que
 * nadie mirara la firma. Con `unknown` el metatype es `Object` y `toValidate()`
 * lo saltea, que es justo lo que hace falta.
 *
 * NO CONFIRMA NI DESMIENTE QUE EL MENSAJE EXISTA. Un Message-ID desconocido y
 * uno de otra empresa responden lo mismo: 202 y `aplicados: 0`. Distinguir los
 * casos convertiria el endpoint en un oraculo para adivinar identificadores. El
 * motivo queda en el log del servidor, que es donde soporte lo necesita.
 *
 * NADA DE LO QUE MANDA EL PROVEEDOR SE ESCRIBE EN EL LOG. Ni el Message-ID —que
 * lleva el dominio de envio—, ni el motivo del rebote, que es texto del servidor
 * del destinatario y suele traer su casilla. Se registran conteos y motivos
 * nuestros. Es la misma linea que ya sigue RegistroCorrelacionService.
 */
@Controller('notif/proveedor')
export class RegistroEnviosProveedorController {
  private readonly logger = new Logger(RegistroEnviosProveedorController.name);

  constructor(
    private readonly registro: RegistroEnviosService,
    @Inject(TRADUCTOR_WEBHOOK)
    private readonly traductor: TraductorWebhookCorreo,
  ) {}

  @Post('estado')
  @Public()
  @SkipTenantContext()
  // 202: se recibio y se proceso lo que correspondia. No es 201 porque no crea
  // nada, y no es 200 porque el efecto puede ser ninguno legitimamente.
  @HttpCode(202)
  async estadoEntrega(
    @Body() cuerpo: unknown,
    @Headers() cabeceras: Record<string, string | string[] | undefined>,
    @Req() peticion: RawBodyRequest<Request>,
  ): Promise<{ recibidos: number; aplicados: number }> {
    const traduccion = await this.traductor.traducir({
      cabeceras,
      cuerpo,
      // Hoy es siempre undefined: la app no levanta con `rawBody: true`. Se pasa
      // igual para que agregarlo sea una linea en main.ts y no un cambio de
      // interfaz. Ver registro-envios.traductor.ts.
      cuerpoCrudo: peticion.rawBody,
      recibidoEnMs: Date.now(),
    });

    if (!traduccion.ok) {
      if (traduccion.motivo === 'sin_secreto') {
        // Falla CERRADA. Sin secreto configurado el canal no existe; aceptar
        // cualquier cuerpo dejaria a cualquiera escribir el estado de entrega
        // de una empresa que no es suya.
        this.logger.error(
          JSON.stringify({
            event: 'webhook_entrega_sin_secreto',
            traductor: this.traductor.nombre,
            variable: WEBHOOK_SECRET_ENV,
          }),
        );
        throw new ServiceUnavailableException('El canal de estados de entrega no está habilitado');
      }
      // El intento rechazado QUEDA REGISTRADO: es el unico rastro de que alguien
      // esta probando el endpoint, y el criterio de aceptacion del issue.
      this.logger.warn(
        JSON.stringify({
          event: 'webhook_entrega_rechazado',
          traductor: this.traductor.nombre,
          motivo: traduccion.motivo,
        }),
      );
      throw new ForbiddenException('Firma de webhook inválida');
    }

    // EN SERIE Y NO EN PARALELO. Cada evento abre su propia transaccion contra
    // el tenant que diga su correlacion, y un lote de cien en paralelo tomaria
    // cien conexiones del pool para un endpoint que cualquiera puede llamar.
    let aplicados = 0;
    const ignorados: Partial<Record<MotivoIgnorado, number>> = {};
    for (const evento of traduccion.eventos) {
      // Idempotencia: el UPDATE del servicio solo toca la fila si el estado
      // CAMBIA y viene de uno abierto ('enviado' o 'entregado'). El mismo evento
      // dos veces se aplica una: la segunda cae en 'estado_no_aplica'.
      const resultado = await this.registro.aplicarEventoProveedor(evento);
      if (resultado.aplicado) {
        aplicados += 1;
        continue;
      }
      const motivo = resultado.ignorado ?? 'estado_no_aplica';
      ignorados[motivo] = (ignorados[motivo] ?? 0) + 1;
    }

    if (aplicados < traduccion.eventos.length) {
      // Sin Message-ID ni correo: por que no se aplicaron, y cuantos.
      this.logger.log(
        JSON.stringify({
          event: 'webhook_entrega_ignorado',
          traductor: this.traductor.nombre,
          motivos: ignorados,
        }),
      );
    }

    return { recibidos: traduccion.eventos.length, aplicados };
  }
}
