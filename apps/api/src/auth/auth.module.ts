import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';

import { MailModule } from '../mail/mail.module';

import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { HandoffService } from './handoff.service';
import { MailService } from './mail.service';
import { AUTH_REDIS, authRedisProvider } from './redis.provider';

@Module({
  imports: [
    MailModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          algorithm: 'HS256',
          issuer: 'sentrycore-api',
          audience: 'sentrycore-clients',
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    HandoffService,
    MailService,
    authRedisProvider,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
  exports: [AuthService, MailService, AUTH_REDIS],
})
export class AuthModule {}
