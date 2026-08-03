# Borrado y exportación completa de un tenant (issue #33)

Con la ley 21.719 vigente, devolver los datos de una empresa cliente ordenados y
borrarlos de verdad deja de ser cortesía y pasa a ser obligación. Este documento
describe cómo se opera, qué cubre y qué queda explícitamente fuera.

Es una operación de **SUPERADMIN** (cruza tenants). Todos los endpoints exigen el
permiso `platform:tenants:manage` y viven fuera del contexto tenant: el acceso a
los datos ocurre únicamente dentro de funciones `SECURITY DEFINER` que validan
`assert_platform_superadmin`, igual que el resto del módulo de plataforma.

## El procedimiento

1. **Exportar** — `GET /platform/tenants/:tenantId/export`
   Devuelve un objeto con `manifest` (conteo de filas por tabla, totales, fecha
   de generación) y `data` (cada tabla volcada a JSON). Las tablas se descubren
   dinámicamente desde `information_schema` buscando la columna `tenant_id`: una
   tabla creada el próximo mes entra sola al export, sin tocar código. Entregar
   este JSON al cliente **antes** de programar el borrado.

2. **Programar el borrado** — `POST /platform/tenants/:tenantId/deletion`
   Body: `{ "reason": "texto de al menos 10 caracteres", "retentionDays": 30 }`
   (`retentionDays` es opcional; default 30, máximo 365). No borra nada: registra
   la solicitud en `tenant_deletions` con `purge_after = now() + retención` y
   estado `programado`. La retención es el seguro contra el borrado por error.
   Solo puede existir una solicitud programada por tenant (índice único parcial).

3. **Ventana de arrepentimiento** — `DELETE /platform/tenants/:tenantId/deletion`
   Cancela la solicitud (estado `cancelado`; la fila queda como historial, nunca
   se elimina). `GET /platform/tenants/deletions` lista lo programado pendiente,
   ordenado por vencimiento.

4. **Ejecutar el purge** — `POST /platform/tenants/:tenantId/deletion/execute`
   Solo procede si existe una solicitud `programado` con `purge_after < now()`
   (la comparación la hace la base, no el reloj de la API). Hace
   `DELETE FROM tenants WHERE id = $1` apoyándose en las cascadas definidas y
   **después verifica**, con el mismo descubrimiento dinámico, que no quede
   ninguna fila con ese `tenant_id` en ninguna tabla. Si queda alguna, lanza
   error con la lista de tablas huérfanas y **no** marca como ejecutado.

   Todo corre en **una transacción**: si la verificación encuentra huérfanas, el
   `DELETE` también se revierte. Nunca queda un tenant borrado a medias.

## Qué cubre

- Todas las tablas de negocio con columna `tenant_id`, presentes y futuras
  (descubrimiento dinámico, mismo criterio que
  `tenant-isolation.integration.spec.ts`).
- La prueba jurídica: la fila de `tenant_deletions` (quién pidió, por qué,
  cuándo se pidió y cuándo se ejecutó) **sobrevive al purge** — por eso la tabla
  no tiene FK a `tenants` y se excluye del export y de la verificación de
  huérfanas.
- Las filas de `platform_audit_log` del tenant se eliminan dentro de
  `platform_purge_tenant` (su FK `RESTRICT` bloquearía el purge de cualquier
  tenant creado por la plataforma). El registro durable del borrado es
  `tenant_deletions`.

## Qué NO cubre (decisiones pendientes o fuera de alcance)

- **Fotos y archivos**: hoy la API no tiene almacenamiento de archivos. Cuando
  exista, el export debe sumar un zip de evidencias (la dependencia prevista es
  `archiver`) y el purge debe borrar los binarios. El manifiesto ya declara
  `photos.status = "pendiente"`.
- **Usuarios**: `users` no tiene columna `tenant_id` (un usuario podría existir
  en más de un tenant), así que ni se exporta ni se borra. El purge elimina las
  `memberships`; los datos personales del usuario (nombre, email) quedan.
  Definir el borrado de usuarios huérfanos es una decisión de equipo pendiente.
- **FKs `RESTRICT` del dominio**: `patrols` → `sites`/`routes`/`memberships`,
  `field_events` → `sites`/`memberships`, `patrol_scans` → `checkpoints` y
  `route_checkpoints` → `checkpoints` son `RESTRICT`. Un tenant **con rondas o
  eventos registrados hoy no se puede purgar**: el `DELETE` falla atómico (la
  API lo traduce a un error claro con la constraint) y no se borra nada.
  Resolverlo exige decisión de equipo: purga por etapas dentro de
  `platform_purge_tenant` o revisar esas FKs. No cerrarlo por cuenta propia —
  el libro de novedades es append-only por razones probatorias (#124).
- **Respaldo y copias**: los dumps de respaldo siguen conteniendo al tenant
  hasta que rote la retención de respaldos (ver `docs/respaldos.md`). El purge
  actúa sobre la base viva, no sobre los backups.
- **Redis / colas**: correos encolados o sesiones activas del tenant no se
  tocan; expiran por TTL propio.
- **Logs**: los logs llevan `tenant_id` y `request_id`, no datos personales,
  y rotan por su cuenta.

## Nota para el equipo de tests de integración

`tenant_deletions` tiene columna `tenant_id` pero **sin RLS** (tabla de
plataforma, mismo criterio que `platform_memberships`: su consumidor es el
SUPERADMIN, que no tiene contexto tenant). El test
`tenant-isolation.integration.spec.ts` exige RLS al 100% de las tablas con
`tenant_id`: hay que excluir `tenant_deletions` de ese barrido, con comentario
del porqué.
