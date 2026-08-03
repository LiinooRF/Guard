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

const databaseUrl = process.env.DATABASE_URL;

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
