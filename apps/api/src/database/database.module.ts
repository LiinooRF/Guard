import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DATABASE_ENTITIES } from './data-source';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres',
        url: config.getOrThrow<string>('DATABASE_URL'),
        entities: DATABASE_ENTITIES,
        synchronize: false,
        migrationsRun: false,
        logging: false,
        invalidWhereValuesBehavior: {
          null: 'throw' as const,
          undefined: 'throw' as const,
        },
      }),
    }),
  ],
})
export class DatabaseModule {}
