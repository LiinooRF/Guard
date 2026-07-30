import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { SkipTenantContext } from '../database/tenant-context/skip-tenant-context.decorator';
import { AuthService } from './auth.service';
import type { AuthenticatedSession } from './auth.types';
import { LoginDto } from './dto/login.dto';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

@Controller('auth')
@SkipTenantContext()
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() input: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.auth.login(input);
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
  async logout(
    @Req() request: Request & { cookies?: Record<string, string> },
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(request.cookies?.voxia_refresh);
    response.clearCookie('voxia_access', { path: '/' });
    response.clearCookie('voxia_refresh', { path: '/' });
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
}
