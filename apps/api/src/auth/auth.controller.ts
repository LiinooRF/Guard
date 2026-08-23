import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IsUUID } from 'class-validator';
import type { Request, Response } from 'express';

import { SkipTenantContext } from '../database/tenant-context/skip-tenant-context.decorator';
import type { AuthenticatedUser } from './auth.guard';
import { AuthService } from './auth.service';
import { HandoffService, type HandoffTicket } from './handoff.service';
import { CompleteAuthActionDto } from './dto/complete-auth-action.dto';
import { HandoffTokenParams } from './dto/handoff-token.dto';
import { Public } from './decorators/public.decorator';
import { Permissions } from './decorators/permissions.decorator';
import { TenantScope } from './decorators/tenant-scope.decorator';
import { LoginDto } from './dto/login.dto';
import { NfcLoginDto } from './dto/nfc-login.dto';
import { RequestPasswordResetDto } from './dto/request-password-reset.dto';
import { clearSessionCookies, setSessionCookies } from './session-cookies';

class SessionParam {
  @IsUUID()
  sessionId!: string;
}

@Controller('auth')
@SkipTenantContext()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly handoff: HandoffService,
    private readonly config: ConfigService,
  ) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @Public()
  async login(
    @Body() input: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.login(
      input,
      request.ip,
      request.get('user-agent') ?? 'Dispositivo desconocido',
    );
    if ('requiresTenantSelection' in result) return result;

    setSessionCookies(response, result);
    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
    };
  }

  @Post('nfc-login')
  @HttpCode(HttpStatus.OK)
  @Public()
  async nfcLogin(
    @Body() input: NfcLoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.nfcLogin(
      input,
      request.ip,
      request.get('user-agent') ?? 'Dispositivo desconocido',
    );
    if ('requiresTenantSelection' in result) return result;

    setSessionCookies(response, result);
    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
    };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Public()
  async logout(
    @Req() request: Request & { cookies?: Record<string, string> },
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(request.cookies?.sentrycore_refresh);
    clearSessionCookies(response);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Public()
  async refresh(
    @Req() request: Request & { cookies?: Record<string, string> },
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.refresh(request.cookies?.sentrycore_refresh);
    setSessionCookies(response, result);
    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
    };
  }

  /**
   * Traspaso de sesion del shell Expo al WebView (#37). Lo pide el shell con su
   * Bearer; no concede nada que el llamante no tenga ya, por eso alcanza con el
   * permiso que poseen los cuatro roles.
   */
  @Post('handoff')
  @HttpCode(HttpStatus.OK)
  @Permissions('account:sessions:manage')
  issueHandoff(@Req() request: Request & { user: AuthenticatedUser }): Promise<HandoffTicket> {
    return this.handoff.issue({
      userId: request.user.sub,
      tenantId: request.user.tenant_id,
      role: request.user.role,
      familyId: request.user.sid,
    });
  }

  /**
   * Publico por necesidad: el WebView todavia no tiene cookies, y es justamente
   * lo que viene a buscar. Lo sostiene que el token sea de un solo uso, dure 60
   * segundos y quede atado a la sesion que lo pidio.
   */
  @Get('handoff/:token')
  @Public()
  async redeemHandoff(
    @Param() params: HandoffTokenParams,
    @Res() response: Response,
  ): Promise<void> {
    const session = await this.handoff.redeem(params.token);
    setSessionCookies(response, session);
    response.setHeader('Cache-Control', 'no-store');
    // El destino sale del entorno, nunca de la peticion: aceptar un ?next=
    // convertiria el canje en un redirector abierto con cookies recien puestas.
    // 303 deja la URL con el token fuera del flujo de navegacion siguiente.
    response.redirect(
      HttpStatus.SEE_OTHER,
      new URL('/app', this.config.getOrThrow<string>('WEB_PUBLIC_URL')).toString(),
    );
  }

  /**
   * Levanta el bloqueo por intentos fallidos de un guardia.
   *
   * Va con `shifts:manage` porque quien lo necesita es el supervisor que tiene
   * al guardia parado en la puerta: el bloqueo dura hasta una hora y hasta hoy
   * no habia forma de acortarlo. Queda auditado por el interceptor, como el
   * resto de las acciones del supervisor.
   */
  @Post('desbloquear/:userId')
  @HttpCode(HttpStatus.OK)
  @Permissions('shifts:manage')
  @TenantScope()
  desbloquearAcceso(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() request: Request & { user: AuthenticatedUser },
  ): Promise<{ identidadesLiberadas: number }> {
    return this.auth.desbloquearAcceso(userId, request.user.tenant_id);
  }

  @Post('password-reset/request')
  @HttpCode(HttpStatus.ACCEPTED)
  @Public()
  async requestPasswordReset(
    @Body() input: RequestPasswordResetDto,
    @Req() request: Request,
  ): Promise<{ message: string }> {
    await this.auth.requestPasswordReset(input.email, request.ip ?? 'unknown');
    return {
      message: 'Si el correo está registrado, recibirás instrucciones para continuar.',
    };
  }

  @Post('password-reset/complete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Public()
  completePasswordReset(@Body() input: CompleteAuthActionDto): Promise<void> {
    return this.auth.completePasswordReset(input);
  }

  @Post('invitations/complete')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Public()
  completeInvitation(@Body() input: CompleteAuthActionDto): Promise<void> {
    return this.auth.completeInvitation(input);
  }

  @Get('session')
  @Permissions('account:sessions:manage')
  session(@Req() request: Request & { user?: AuthenticatedUser }) {
    return {
      user: request.user
        ? {
            id: request.user.sub,
            tenantId: request.user.tenant_id,
            role: request.user.role,
          }
        : null,
    };
  }

  @Get('sessions')
  @Permissions('account:sessions:manage')
  sessions(@Req() request: Request & { user: AuthenticatedUser }) {
    return this.auth.listSessions(request.user.sub, request.user.sid);
  }

  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('account:sessions:manage')
  async revokeSession(
    @Param() params: SessionParam,
    @Req() request: Request & { user: AuthenticatedUser },
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const revoked = await this.auth.revokeSession(request.user.sub, params.sessionId);
    if (!revoked) throw new NotFoundException('Sesión no encontrada');
    if (params.sessionId === request.user.sid) clearSessionCookies(response);
  }

  @Delete('sessions')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Permissions('account:sessions:manage')
  async revokeAllSessions(
    @Req() request: Request & { user: AuthenticatedUser },
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.revokeAllSessions(request.user.sub);
    clearSessionCookies(response);
  }
}
