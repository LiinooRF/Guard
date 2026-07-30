import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { authRedisProvider } from './redis.provider';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: {
          algorithm: 'HS256',
          issuer: 'voxia-api',
          audience: 'voxia-clients',
        },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, authRedisProvider],
})
export class AuthModule {}
