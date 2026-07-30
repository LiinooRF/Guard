# Autorización

La autorización se decide en la API. La interfaz puede ocultar acciones, pero eso no reemplaza los
guards del servidor.

La fuente de verdad ejecutable es `packages/shared/src/roles.ts`: `PERMISSIONS` define el catálogo y
`ROLE_PERMISSIONS` la matriz. Los tests y los guards deben importar esas constantes; no deben mantener
copias ni preguntar directamente por un rol.

## Matriz rol × permiso

| Permiso | SUPERADMIN | ADMIN | SUPERVISOR | GUARDIA |
|---|:---:|:---:|:---:|:---:|
| `platform:tenants:manage` | ✓ | | | |
| `platform:metrics:read` | ✓ | | | |
| `platform:branding:manage` | ✓ | | | |
| `platform:support:access` | ✓ | | | |
| `tenant:users:manage` | | ✓ | | |
| `tenant:sites:manage` | | ✓ | | |
| `tenant:rules:manage` | | ✓ | | |
| `tenant:stats:read` | | ✓ | | |
| `tenant:audit:read` | | ✓ | | |
| `routes:manage` | | | ✓ | |
| `shifts:manage` | | | ✓ | |
| `patrols:monitor` | | | ✓ | |
| `patrols:execute` | | | | ✓ |
| `reports:read` | | ✓ | ✓ | |
| `incidents:create` | | | ✓ | ✓ |

## Alcance obligatorio

Conceder un permiso no basta por sí solo:

- `SUPERADMIN` es el único rol que cruza tenants. `platform:support:access` no habilita acceso
  silencioso: requiere el flujo explícito de soporte y auditoría.
- `ADMIN`, `SUPERVISOR` y `GUARDIA` solo acceden a su propio tenant.
- `SUPERVISOR` se limita además a sus recintos asignados.
- `GUARDIA` se limita a la ronda que tiene asignada en el turno.

Estas restricciones de alcance se verifican después del permiso, con el tenant y los recursos
obtenidos de la sesión; nunca con identificadores confiados desde el cliente.
