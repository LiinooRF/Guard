import { Body, Controller, Delete, Param, Post, Req } from '@nestjs/common';
import { IsString, Length, Matches } from 'class-validator';
import type { Request } from 'express';

import type { AuthenticatedUser } from '../auth/auth.guard';
import { Permissions } from '../auth/decorators/permissions.decorator';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { PushService } from './push.service';

class TokenParam {
  @IsString()
  @Length(8, 4096)
  @Matches(/^[\x21-\x7e]+$/)
  token!: string;
}

type Autenticado = Request & { user: AuthenticatedUser };

/**
 * Cada usuario administra SUS dispositivos, igual que sus sesiones y su
 * consentimiento de ubicacion: por eso `account:sessions:manage` y no un
 * permiso nuevo. Registrar un telefono es exactamente eso — abrir un canal
 * hacia la propia cuenta.
 *
 * @TenantScope() NO se declara, por la misma razon que en GeoController: ese
 * permiso lo tienen los 4 roles, incluido SUPERADMIN, que por definicion no
 * tiene tenant, y marcarlo romperia la invariante de la matriz de autorizacion.
 * Los endpoints igual corren dentro de la transaccion con RLS —el
 * TenantContextInterceptor es global— y una sesion sin tenant recibe 401. Un
 * SUPERADMIN no registra dispositivos: las alertas de terreno son del ADMIN y
 * del SUPERVISOR de la empresa.
 */
@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Post('devices')
  @Permissions('account:sessions:manage')
  registerDevice(@Body() input: RegisterDeviceDto, @Req() request: Autenticado) {
    return this.push.register(
      request.user.sub,
      input.token,
      input.platform,
      input.appVersion,
    );
  }

  /**
   * El token va en la ruta por el contrato del issue. Es una credencial de
   * entrega, asi que el registro de accesos lo enmascara: ver `loggedPath()` en
   * observability/request-logging.middleware.ts, que ya hacia lo mismo con el
   * token de traspaso al WebView. Sin eso, cada cierre de sesion dejaria un
   * token de push en claro en el log.
   */
  @Delete('devices/:token')
  @Permissions('account:sessions:manage')
  unregisterDevice(@Param() params: TokenParam, @Req() request: Autenticado) {
    return this.push.unregister(params.token, request.user.sub);
  }
}
