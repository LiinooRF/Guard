import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { validateEnv } from './config/env';
import { HealthController } from './health/health.controller';
import { RulesController } from './rules/rules.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      // El .env vive en la raiz del monorepo, compartido por api y web.
      envFilePath: ['../../.env'],
      validate: validateEnv,
    }),
  ],
  controllers: [HealthController, RulesController],
})
export class AppModule {}
