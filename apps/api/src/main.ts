import 'reflect-metadata';

import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

import { AppModule } from './app.module';
import { csrfOriginProtection } from './security/csrf-origin.middleware';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    // Logs estructurados: cada linea tiene que poder correlacionarse con un
    // request y un tenant. Ver issue #6.
    logger: ['error', 'warn', 'log'],
  });

  app.use(helmet());
  app.use(cookieParser());
  app.use(csrfOriginProtection(process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000'));
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );

  // La app movil y la web consumen esta misma API.
  app.enableCors({
    origin: [process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000'],
    credentials: true,
  });

  app.setGlobalPrefix('api', { exclude: ['health', 'ready'] });

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');

  new Logger('bootstrap').log(`voxia-api escuchando en http://localhost:${port}`);
}

void bootstrap();
