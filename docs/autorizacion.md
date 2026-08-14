# Autorización

La autorización se decide en la API. La interfaz puede ocultar acciones, pero eso no reemplaza los
guards del servidor.

La fuente de verdad ejecutable es `packages/shared/src/permissions.ts`: `PERMISSIONS` define el catálogo y
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
| `checklists:manage` | | | ✓ | |
| `checkpoints:manage` | | | ✓ | |
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

### `checkpoints:manage` no es `tenant:sites:manage` en chico (#309)

El `SUPERVISOR` da de alta **puntos de control** y vincula sus **etiquetas NFC**,
en los recintos que tiene asignados. Lo que ese permiso **no** incluye, y no por
olvido:

| Fuera del permiso | Por qué |
|---|---|
| Crear, editar o dar de baja **recintos**, y su horario hábil y feriados | Es infraestructura de la empresa: sigue en `tenant:sites:manage`, del `ADMIN` |
| `PATCH /admin/checkpoints/:id/photo` y cambiar `kind` al **editar** | Los dos gobiernan `isPhotoRequired()`: con ellos se apaga la evidencia fotográfica de un acceso crítico sin pasar por ninguna pantalla de reglas |
| `GET /admin/tags/resolve` | Resuelve un UID contra **todo** el tenant: es un mapa de los recintos que no son suyos |
| El **QR de respaldo** (`/qr/...`) | Emitir un QR es crear una etiqueta: si el supervisor lo necesita es un issue aparte con su propia decisión, no un efecto lateral |
| `PATCH /admin/users/:userId/sites/:siteId` | Es la puerta de la **auto-asignación**: convertiría el permiso en acceso a la empresa entera. Pide `tenant:users:manage` **y** `tenant:sites:manage` |

El intercambio que se acepta a cambio: quien puede **re-vincular** una etiqueta
puede simular presencia —una calcomanía nueva pegada en la caseta y el punto
lejano queda "visitado"— y quien puede mover las coordenadas de un punto mueve la
vara del marcado de anomalías. Por eso las cuatro escrituras de terreno quedan en
`audit_log` (`punto.creado`, `punto.modificado`, `etiqueta.registrada`,
`etiqueta.retirada`), en **los dos** caminos, con el reemplazo y el cambio de
coordenadas nombrados explícitamente en el resumen. Dar de baja un punto también
es legítimo dentro de sus recintos y también achica el denominador de
`computeCompliance()`: queda auditado en vez de escondido.

Estas restricciones de alcance se verifican después del permiso, con el tenant y los recursos
obtenidos de la sesión; nunca con identificadores confiados desde el cliente.
