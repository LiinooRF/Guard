import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ROLES } from '@voxia/shared';
import { IsUUID } from 'class-validator';
import type { Request, Response } from 'express';

import { SkipTenantContext } from '../database/tenant-context/skip-tenant-context.decorator';
import type { AuthenticatedUser } from './auth.guard';
import { AuthService } from './auth.service';
import type { AuthenticatedSession } from './auth.types';
import { Public } from './decorators/public.decorator';
import { Roles } from './decorators/roles.decorator';
import { LoginDto } from './dto/login.dto';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

class SessionParam {
  @IsUUID()
  sessionId!: string;
}

@Controller('auth')
@SkipTenantContext()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

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

    this.setSessionCookies(response, result);
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
    await this.auth.logout(request.cookies?.voxia_refresh);
    response.clearCookie('voxia_access', { path: '/' });
    response.clearCookie('voxia_refresh', { path: '/' });
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Public()
  async refresh(
    @Req() request: Request & { cookies?: Record<string, string> },
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.refresh(request.cookies?.voxia_refresh);
    this.setSessionCookies(response, result);
    return {
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user,
    };
  }

  @Get('session')
  @Roles(...ROLES)
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
  @Roles(...ROLES)
  sessions(@Req() request: Request & { user: AuthenticatedUser }) {
    return this.auth.listSessions(request.user.sub, request.user.sid);
  }

  @Delete('sessions/:sessionId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(...ROLES)
  async revokeSession(
    @Param() params: SessionParam,
    @Req() request: Request & { user: AuthenticatedUser },
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const revoked = await this.auth.revokeSession(request.user.sub, params.sessionId);
    if (!revoked) throw new NotFoundException('Sesión no encontrada');
    if (params.sessionId === request.user.sid) this.clearSessionCookies(response);
  }

  @Delete('sessions')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Roles(...ROLES)
  async revokeAllSessions(
    @Req() request: Request & { user: AuthenticatedUser },
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.revokeAllSessions(request.user.sub);
    this.clearSessionCookies(response);
  }

  private setSessionCookies(response: Response, session: AuthenticatedSession): void {
    const secure = process.env.NODE_ENV === 'production';
    const common = {
      httpOnly: true,
      sameSite: 'lax' as const,
      secure,
      path: '/',
    };

    response.cookie('voxia_access', session.accessToken, {
      ...common,
      maxAge: FIFTEEN_MINUTES_MS,
    });
    response.cookie('voxia_refresh', session.refreshToken, {
      ...common,
      maxAge: THIRTY_DAYS_MS,
    });
  }

  private clearSessionCookies(response: Response): void {
    response.clearCookie('voxia_access', { path: '/' });
    response.clearCookie('voxia_refresh', { path: '/' });
  }
}
