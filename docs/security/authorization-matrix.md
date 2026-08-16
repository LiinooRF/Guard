# Matriz de autorización

La fuente de verdad ejecutable es
[`packages/shared/src/permissions.ts`](../../packages/shared/src/permissions.ts).
Este documento explica esa matriz; el test
[`authorization-matrix.spec.ts`](../../apps/api/src/auth/authorization-matrix.spec.ts)
impide que el documento operativo se degrade en endpoints sin política.

Los controladores declaran permisos con `@Permissions(...)`. El guard global
resuelve esos permisos mediante `ROLE_PERMISSIONS` y deniega por defecto todo
endpoint sin `@Public()` o sin permisos. Agregar o reasignar un permiso no
requiere cambiar el guard.

## Roles y alcance

| Rol | Alcance | Permisos |
|---|---|---|
| `SUPERADMIN` | Plataforma, cruza tenants sin adoptar silenciosamente su contexto | sesiones propias; empresas; métricas; marca; soporte |
| `ADMIN` | Tenant completo, aislado por RLS | sesiones propias; panel; usuarios; recintos; reglas; estadísticas; auditoría; seguridad; informes |
| `SUPERVISOR` | Tenant y sólo recintos asignados | sesiones propias; panel; rutas; turnos; tareas del turno; **puntos de control y sus etiquetas NFC**; monitoreo; informes; incidentes |
| `GUARDIA` | Tenant y ronda asignada | sesiones propias; ejecutar ronda; incidentes |

La restricción de recinto del supervisor se aplica además del permiso: las
consultas parten de `supervisor_sites` y RLS mantiene el aislamiento del tenant.

## Endpoints autenticados actuales

| Área | Operaciones | Permiso | Roles |
|---|---|---|---|
| Sesión | consultar sesión/dispositivos y revocarlos | `account:sessions:manage` | los cuatro |
| Admin/usuarios | listar, crear, activar, revocar sesiones y asignar recintos | `tenant:users:manage` | `ADMIN` |
| Admin/recintos | listar, crear, activar y participar en la asignación; también sus puntos de control y etiquetas sobre el tenant completo | `tenant:sites:manage` | `ADMIN` |
| Terreno/puntos | listar, crear, importar, editar y dar de baja puntos; listar, vincular y retirar etiquetas — **sólo en los recintos asignados** | `checkpoints:manage` | `SUPERVISOR` |
| Admin/seguridad | política de acceso y eventos | `tenant:security:manage` | `ADMIN` |
| Panel tenant | resumen operacional autorizado | `tenant:dashboard:read` | `ADMIN`, `SUPERVISOR` |
| Guardia | inicio y ejecución de su ronda | `patrols:execute` | `GUARDIA` |
| Plataforma | empresas y estado | `platform:tenants:manage` | `SUPERADMIN` |
| Plataforma | facturación y métricas | `platform:metrics:read` | `SUPERADMIN` |

`login`, `logout`, `refresh`, solicitud/consumo de recuperación e invitación,
`health`, `ready` y los defaults públicos de reglas son las únicas rutas
públicas inventariadas.

## Controles automáticos

- Todas las combinaciones de los 4 roles y los 20 permisos pasan por el guard.
- El inventario compara todos los métodos HTTP de todos los controladores: una
  ruta nueva sin entrada y política hace fallar la suite.
- La integración compara el catálogo PostgreSQL con la matriz compartida.
- Las pruebas RLS intentan lecturas y cambios entre tenants en todas las tablas.
- El panel del supervisor se prueba con recinto asignado, no asignado y otro
  tenant.
