import 'dotenv/config';

import { DataSource } from 'typeorm';

import {
  MembershipEntity,
  PermissionEntity,
  PlatformMembershipEntity,
  RoleEntity,
  TenantEntity,
  UserEntity,
} from './entities';

// El proceso de migración usa una credencial administrativa separada. La API
// siempre conserva DATABASE_URL con el rol restringido por RLS.
// Acepta ambos nombres: DATABASE_MIGRATION_URL (canónico del equipo) y
// MIGRATION_DATABASE_URL (el que exporta el compose de Dokploy).
const databaseUrl =
  process.env.DATABASE_MIGRATION_URL ||
  process.env.MIGRATION_DATABASE_URL ||
  process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL es obligatoria para conectar a PostgreSQL');
}

export const DATABASE_ENTITIES = [
  TenantEntity,
  UserEntity,
  RoleEntity,
  PermissionEntity,
  MembershipEntity,
  PlatformMembershipEntity,
];

export const AppDataSource = new DataSource({
  type: 'postgres',
  url: databaseUrl,
  entities: DATABASE_ENTITIES,
  migrations: [`${__dirname}/migrations/*{.ts,.js}`],
  migrationsTableName: 'schema_migrations',
  synchronize: false,
  migrationsRun: false,
  logging: false,
  invalidWhereValuesBehavior: {
    null: 'throw',
    undefined: 'throw',
  },
});
