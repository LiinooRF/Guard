import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';

import type { Env } from '../config/env';
import { DatabaseModule } from '../database/database.module';
import { createFcmProvider } from './fcm.provider';
import { LogPushProvider } from './log.provider';
import { PUSH_PROVIDER, type PushProvider } from './push-provider';
import { PUSH_QUEUE_NAME } from './push-queue.constants';
import { PushController } from './push.controller';
import { PushProcessor } from './push.processor';
import { PushService } from './push.service';

type PushEnvironment = Pick<
  Env,
  'PUSH_DRIVER' | 'FCM_PROJECT_ID' | 'FCM_CLIENT_EMAIL' | 'FCM_PRIVATE_KEY'
>;

export function createPushProvider(env: PushEnvironment): PushProvider {
  if (env.PUSH_DRIVER === 'log') {
    return new LogPushProvider();
  }

  // La validacion de entorno ya exige estas tres con PUSH_DRIVER=fcm; el
  // chequeo se repite aca porque la fabrica tambien se usa desde los tests.
  if (!env.FCM_PROJECT_ID || !env.FCM_CLIENT_EMAIL || !env.FCM_PRIVATE_KEY) {
    throw new Error('PUSH_DRIVER=fcm requiere FCM_PROJECT_ID, FCM_CLIENT_EMAIL y FCM_PRIVATE_KEY');
  }

  return createFcmProvider({
    projectId: env.FCM_PROJECT_ID,
    clientEmail: env.FCM_CLIENT_EMAIL,
    // La clave viaja con los saltos de linea escapados porque atraviesa un
    // .env y el panel de Dokploy; PEM sin saltos reales no se puede firmar.
    privateKey: env.FCM_PRIVATE_KEY.split('\\n').join('\n'),
  });
}

/**
 * DatabaseModule es obligatorio: PushService inyecta TenantContextService.
 *
 * La conexion de BullMQ NO se registra aca. `BullModule.forRootAsync` de
 * MailModule se declara `global: true`, asi que la comparte todo el proceso;
 * declararla dos veces abriria una segunda conexion a Redis para nada. Si algun
 * dia MailModule deja de registrarla, la raiz se sube a AppModule y este modulo
 * no cambia.
 *
 * Se exporta PushService porque quien avisa es otro: escalation manda el push
 * junto con el correo (ver INTEGRACION.md).
 */
@Module({
  imports: [DatabaseModule, BullModule.registerQueue({ name: PUSH_QUEUE_NAME })],
  controllers: [PushController],
  providers: [
    {
      provide: PUSH_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        createPushProvider({
          PUSH_DRIVER: config.get('PUSH_DRIVER', { infer: true }),
          FCM_PROJECT_ID: config.get('FCM_PROJECT_ID', { infer: true }),
          FCM_CLIENT_EMAIL: config.get('FCM_CLIENT_EMAIL', { infer: true }),
          FCM_PRIVATE_KEY: config.get('FCM_PRIVATE_KEY', { infer: true }),
        }),
    },
    PushService,
    PushProcessor,
  ],
  exports: [PushService],
})
export class PushModule {}
