# ADR 0001: TypeORM y migraciones SQL versionadas

## Estado

Aceptada.

## Decisión

La API usa TypeORM como integración con NestJS y como ejecutor de migraciones. El esquema se define
mediante migraciones versionadas con métodos `up` y `down`; `synchronize` y `migrationsRun` permanecen
desactivados.

Las reglas críticas de aislamiento se expresan en SQL de PostgreSQL. TypeORM no reemplaza RLS ni el
contexto transaccional por request.

## Motivos

- integración oficial y mantenida con NestJS;
- `QueryRunner` permite reservar una conexión y controlar la transacción necesaria para `SET LOCAL`;
- las migraciones SQL hacen visibles y revisables políticas, constraints e índices específicos de
  PostgreSQL;
- no se infiere ni modifica el esquema durante el arranque de producción.

## Operación

```bash
npm run db:migrate --workspace @sentrycore/api
npm run db:revert --workspace @sentrycore/api
npm run seed --workspace @sentrycore/api
```

Las migraciones corren antes del despliegue con credenciales de migración. La API usa `sentrycore_app`,
sin superusuario ni `BYPASSRLS`.
