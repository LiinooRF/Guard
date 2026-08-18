# Guía del panel web — contexto completo

> **Si eres un agente de IA trabajando en `apps/web/`, este archivo es tu punto de partida.**
> Léelo entero antes de escribir código, y después lee [`CLAUDE.md`](../CLAUDE.md) para las reglas
> del producto que no se negocian. Este documento cubre lo que aquel no: **qué API existe hoy, cómo
> se consume, y qué falta construir**.

---

## 1. Qué es el producto, en dos párrafos

**SentryCore** es un SaaS multi-tenant de monitoreo de rondas de vigilancia. Un guardia recorre
puntos de control físicos; en cada uno hay una etiqueta NFC pegada que toca con el teléfono, y eso
queda registrado con hora y GPS. En los accesos críticos además fotografía el estado de la puerta. Al
escanear el último punto, **la ronda se cierra sola** y se envía el informe; si el cumplimiento baja
del umbral configurado, la alerta va directo al admin de la empresa.

Muchas empresas de seguridad comparten la misma instancia, cada una con su marca y sus reglas. Esa
frase gobierna casi todo: **nada se codifica para "el cliente"**, todo es configuración del tenant.

## 2. El estado real, hoy

**El backend está bastante avanzado. La interfaz web casi no existe.** Ese es exactamente el trabajo
de este carril.

| | Estado |
|---|---|
| API de catálogo, rondas, escaneo, eventos, reglas | **funcionando y desplegado** |
| Login con los 4 roles, sesiones, permisos | **funcionando** |
| Panel web | **solo login + cascarón por rol** ← tu trabajo |
| App móvil | sin inicializar (otro carril) |

Puedes probar todo lo que existe en el ambiente de pruebas:

- **https://test-sentrycore.voxtilabs.cl** — el panel
- **https://test-sentrycore.voxtilabs.cl/correo** — bandeja de correo de pruebas (usuario `sentrycore`)
- Requiere estar en el **tailnet** del equipo. El VPS no está abierto a internet a propósito.

**Cuentas demo** (clave para todas: la que el equipo comparte por el grupo, `DemoGuardia2026!` en
staging):

| Cuenta | Rol |
|---|---|
| `superadmin@demo-platform.test` | SUPERADMIN — la plataforma, cruza empresas |
| `admin@demo-andina.test` | ADMIN — dueño de la empresa "Andina" |
| `supervisor@demo-andina.test` | SUPERVISOR — jefe de terreno |
| `guardia@demo-andina.test` | GUARDIA — solo app móvil |
| `guardia@demo-pacifico.test` | GUARDIA de **otra empresa** — úsalo para verificar que el aislamiento funciona |

## 3. Los 4 roles y qué ve cada uno

Rol y plataforma son **ejes separados**: el rol define permisos, la plataforma es consecuencia de la
tarea.

| Rol | Dónde | Qué administra |
|---|---|---|
| `SUPERADMIN` | desktop | **Cruza empresas.** Alta de tenants, licencias, white-label, métricas globales |
| `ADMIN` | desktop | Su empresa: usuarios, recintos, puntos, **configuración de reglas**, estadísticas |
| `SUPERVISOR` | desktop **y** app | **Solo los recintos que tiene asignados**: rutas, turnos, monitoreo |
| `GUARDIA` | **solo app** | Su ronda del turno. El middleware lo expulsa del navegador a propósito |

`SUPERVISOR` tiene una restricción extra sobre el rol: está limitado a **sus recintos asignados**. El
backend responde `403` si pide un recinto que no le corresponde — la interfaz debe manejar ese caso
sin romperse, no asumir que todo recinto es visible.

## 4. Cómo se autentica el navegador

El login ya está resuelto; **no lo reimplementes**. Cómo funciona:

1. `POST /api/auth/login` con `{ identity, password }` y `credentials: 'include'`.
2. El servidor responde con el usuario **y setea dos cookies `HttpOnly`**: `sentrycore_access` (15 min) y
   `sentrycore_refresh` (30 días). El JavaScript **no puede leerlas, y eso es deliberado**.
3. `apps/web/middleware.ts` valida la sesión en cada navegación llamando a la API por la red interna
   y redirige al rol correcto (`/app/admin`, `/app/supervisor`, `/app/superadmin`).
4. Toda llamada a la API desde el navegador va con **`credentials: 'include'`**. Si se te olvida, el
   servidor responde 401 aunque el usuario esté logueado.

```ts
const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? '/api';
const r = await fetch(`${apiUrl}/admin/sites`, { credentials: 'include' });
```

> **La URL de la API se hornea en el bundle al compilar.** `'/api'` significa mismo origen, que es lo
> que usa staging hoy. No inventes otra forma de resolverla.

## 5. La API que ya existe — tu materia prima

Todas bajo `/api`. Los permisos son los del catálogo en `packages/shared/src/permissions.ts`; el
backend **exige todos los permisos declarados** en cada endpoint (es un AND).

### Sesión — todos los roles
```
POST   /auth/login            {identity, password}     → usuario + cookies
POST   /auth/logout
GET    /auth/session                                   → {user:{id,tenantId,role}}
GET    /auth/sessions                                  → sesiones activas del usuario
DELETE /auth/sessions/:sessionId                       → cerrar una
DELETE /auth/sessions                                  → cerrar todas
POST   /auth/password-reset/request     {email}
POST   /auth/password-reset/complete    {token, password}
POST   /auth/invitations/complete       {token, password}
```

### ADMIN — `/admin` (permiso según endpoint, todos con contexto de empresa)
```
GET    /admin/users                                    tenant:users:manage
POST   /admin/users     {email?, username?, givenName, familyName, role, password?}
PATCH  /admin/users/:userId                   {givenName, familyName, role}
PATCH  /admin/users/:userId/active            {isActive}
DELETE /admin/users/:userId/sessions                   → cierra sus sesiones
PATCH  /admin/users/:userId/sites/:siteId     {assigned}   ← asigna recinto a un supervisor

GET    /admin/sites                                    tenant:sites:manage
POST   /admin/sites     {branchName, name, address, latitude?, longitude?}
PATCH  /admin/sites/:siteId {branchName?, name?, address?, latitude?, longitude?, timezone?}
PATCH  /admin/sites/:siteId/active            {isActive}

GET    /admin/sites/:siteId/business-hours
PUT    /admin/sites/:siteId/business-hours {hours:[{weekday, opensAt, closesAt}]}
GET    /admin/sites/:siteId/holidays
PUT    /admin/sites/:siteId/holidays       {holidays:[{date, name?}]}

GET    /admin/sites/:siteId/checkpoints
POST   /admin/sites/:siteId/checkpoints  {name, description?, kind?, suggestedOrder?,
                                          latitude?, longitude?, requiresPhoto?, instructions?, tagUid?}
POST   /admin/sites/:siteId/checkpoints/import {checkpoints:[...]}  ← carga CSV atomica
PATCH  /admin/checkpoints/:checkpointId       {campos parciales}
PATCH  /admin/checkpoints/:checkpointId/photo {requiresPhoto: true|false|null}
PATCH  /admin/checkpoints/:checkpointId/active {isActive}

GET    /admin/checkpoints/:checkpointId/tags           ← etiquetas NFC/QR del punto
POST   /admin/checkpoints/:checkpointId/tags  {uid, tech?}
DELETE /admin/tags/:tagId                              ← retira (no borra: queda historial)
GET    /admin/tags/resolve?uid=...                     ← a qué punto pertenece un UID

GET    /admin/security/policy                          tenant:security:manage
PATCH  /admin/security/policy  {maxFailedAttempts, windowSeconds, baseLockSeconds, maxLockSeconds}
GET    /admin/security/events                          ← bloqueos por fuerza bruta
```

### Reglas configurables — el corazón del SaaS
```
GET  /rules/defaults          público    → los defaults del producto
GET  /rules/catalog           público    → catálogo de parámetros para pintar el formulario
GET  /rules/effective?siteId=&checkpointId=   cualquier rol dentro del tenant
                              → {context, rules, sources, layers}
GET  /rules/admin             tenant:rules:manage → {scope, effective, overrides, sources, layers, editable}
PUT  /rules/admin             {complianceThreshold?, photoRequiredOutsideHours?, ...}

GET  /rules/admin/sites/:siteId              tenant:rules:manage
PUT  /rules/admin/sites/:siteId
GET  /rules/admin/checkpoints/:checkpointId  tenant:rules:manage
PUT  /rules/admin/checkpoints/:checkpointId

GET  /platform/rules          platform:tenants:manage  ← SUPERADMIN, sin contexto de empresa
PUT  /platform/rules
```
`PUT` **reemplaza el set completo** de overrides de ese nivel: omitir un campo lo devuelve al valor
que hereda del nivel de arriba. Un campo desconocido responde 400, y una regla que ese nivel no
configura también (`photoRetentionDays` en un punto, por ejemplo).

**No hardcodees ni un nombre de campo ni un rango en la web**: `GET /rules/catalog` devuelve cada
parámetro con tipo, mínimo, máximo, unidad, default, descripción en lenguaje del cliente y en qué
niveles se puede configurar (`scopes`). `sources` dice de qué nivel salió cada valor efectivo, que es
lo que distingue "heredado" de "escrito acá" en el formulario. La cascada es
`plataforma → tenant → recinto → punto` y la resuelve el servidor.

### SUPERVISOR — `/supervisor` (solo sus recintos asignados; 403 si no)
```
GET   /supervisor/route-editor/sites                  routes:manage
      → recintos asignados con puntos activos, coordenadas y requisito de foto
GET   /supervisor/sites/:siteId/routes                 routes:manage
POST  /supervisor/sites/:siteId/routes  {name, estimatedDurationMin, toleranceMin?,
                                         orderMode?, checkpoints:[{checkpointId, isClosingPoint?,
                                         isAnchor?, requiresPhoto?}]}
PUT   /supervisor/routes/:routeId       {campos parciales; mandar checkpoints SUBE la versión}
PATCH /supervisor/routes/:routeId/active {isActive}

POST  /supervisor/routes/:routeId/patrols  {guardId, scheduledStartAt, scheduledEndAt}   shifts:manage
GET   /supervisor/sites/:siteId/patrols                patrols:monitor
GET   /supervisor/sites/:siteId/events                 patrols:monitor  ← novedades y pánico
GET   /supervisor/live                                 patrols:monitor
      → rondas pendientes/en curso de los recintos asignados, progreso, último escaneo y
        posición más reciente solo cuando la regla GPS efectiva está activa
```

#### Puntos de control y etiquetas NFC — `/checkpoints/supervisor` (#309)

Primer segmento distinto de `/admin` y de `/supervisor` a propósito: así ninguna
ruta puede quedar tapada por otra según el orden de registro. Las ocho piden
`checkpoints:manage` y comprueban `supervisor_sites` **en el servidor**; el id
del supervisor sale del token, nunca de la URL.

```
GET    /checkpoints/supervisor/sites/:siteId/checkpoints
POST   /checkpoints/supervisor/sites/:siteId/checkpoints  {name, description?, kind?,
                                          suggestedOrder?, latitude?, longitude?,
                                          instructions?, tagUid?}
POST   /checkpoints/supervisor/sites/:siteId/checkpoints/import {checkpoints:[...]}
PATCH  /checkpoints/supervisor/checkpoints/:checkpointId        {campos parciales, SIN kind}
PATCH  /checkpoints/supervisor/checkpoints/:checkpointId/active {isActive}
GET    /checkpoints/supervisor/checkpoints/:checkpointId/tags
POST   /checkpoints/supervisor/checkpoints/:checkpointId/tags   {uid, tech?}
DELETE /checkpoints/supervisor/tags/:tagId
```

Códigos: **404** = el punto no existe, o es de otra empresa (RLS lo tapa antes y
no se revela que exista). **403** = existe en tu empresa pero su recinto no está
entre los tuyos. **400** = mandaste `requiresPhoto`, `kind` al editar o `siteId`
en el cuerpo: no están en el DTO y `forbidNonWhitelisted` los rechaza.

Los recintos para el selector salen de `GET /supervisor/sites`, que ya devuelve
solo los asignados. **`GET /admin/sites` no sirve acá** y no es un detalle de la
pantalla sino del permiso.

Lo que sigue siendo solo del `ADMIN`: el CRUD de recintos, el horario hábil y los
feriados, `PATCH /admin/checkpoints/:id/photo`, `GET /admin/tags/resolve` y el QR
de respaldo. Ver `docs/autorizacion.md` para el porqué de cada uno.

El tablero consulta `/supervisor/live` cada 5 segundos (también al volver a una pestaña visible),
por debajo del límite de 10 segundos del producto. `pollAfterMs` viene en la respuesta para dejar
explícito el contrato. El mapa recibe `MAP_TILE_URL` y `MAP_ATTRIBUTION` desde el servidor; en los
compose productivos el proveedor es obligatorio y nunca cae silenciosamente en los tiles públicos
de OpenStreetMap.

### SUPERADMIN — `/platform/tenants` (sin contexto de empresa)
```
GET   /platform/tenants                                platform:tenants:manage
POST  /platform/tenants
PATCH /platform/tenants/:tenantId/status
GET   /platform/tenants/billing/current                platform:metrics:read
GET   /platform/tenants/mail-queue                     ← estado de la cola de correo
```

### Auditoría y estadísticas — ADMIN

```
GET /admin/audit          tenant:audit:read
    ?actorId= &action= &from= &to= &limit=      (limit tope 500)
    → [{ id, actorId, actorLabel, action, entityType, entityId, summary, createdAt }]
GET /admin/audit/actions  tenant:audit:read     → las acciones presentes, para el filtro

GET /admin/stats/overview tenant:stats:read     ?from= &to=
    → { threshold, global{...}, byBranch[...], worstSites[...] }   (peor primero)
GET /admin/stats/trend    tenant:stats:read     ?from= &to= &branchName=
    → [{ week, patrols, compliancePct }]
```

La auditoría es **solo lectura**: es append-only en PostgreSQL, la API ni siquiera tiene permiso de
`UPDATE`. Muestra `actorLabel`, no `actorId` — el id puede apuntar a un usuario ya eliminado.

### Turnos y jornada

```
GET  /supervisor/sites/:siteId/shifts        shifts:manage
POST /supervisor/sites/:siteId/shifts        {name, startsAt, endsAt, weekdays?, entryToleranceMin?}
POST /supervisor/shifts/:shiftId/assignments {guardId, serviceDate}      shifts:manage
GET  /supervisor/sites                       ← recintos asignados al supervisor
GET  /supervisor/sites/:siteId/guards        ← guardias activos disponibles
GET  /supervisor/sites/:siteId/schedule?from=YYYY-MM-DD ← siete días de asignaciones
POST /supervisor/shifts/:shiftId/conflicts   {guardId, serviceDate}      ← prevalidación, no escribe
PATCH /supervisor/assignments/:assignmentId  {guardId}                  ← reemplazo antes de iniciar
GET  /supervisor/sites/:siteId/on-duty       patrols:monitor  ← quién está de servicio AHORA
```

`startsAt > endsAt` es un **turno nocturno** que cruza medianoche, no un error. La respuesta trae
`crossesMidnight` para que la interfaz lo muestre bien. La prevalidación y el alta comparan rangos
reales en el huso del recinto; dos ventanas contiguas son válidas, pero un cruce nocturno con el día
siguiente se considera solapamiento. El servidor vuelve a comprobarlo al insertar y serializa por
guardia, de modo que dos solicitudes simultáneas tampoco pueden crear el choque.

### Informes y evidencia

```
GET  /reports/patrols/:patrolId              reports:read   → PDF (application/pdf)
GET  /reports/sites/:siteId?from=&to=        reports:read   → PDF de resumen por sucursal
GET  /evidence/patrols/:patrolId/photos      reports:read   → metadatos del anexo fotográfico
POST /evidence/scans/:scanId/photos          patrols:execute → evidencia de un escaneo (multipart)
POST /evidence/events/:eventId/photos        patrols:execute → foto de una novedad (multipart)
GET  /evidence/events/:eventId/photos        reports:read   → fotos de una novedad
```

Los dos primeros devuelven **bytes de PDF**, no JSON: descárgalos con `blob`, no con `.json()`.

Las dos subidas son **multipart** con el archivo en el campo `foto` y `takenAtDevice` opcional. Tres
respuestas que la interfaz tiene que distinguir, porque no significan lo mismo:

- **409** = *foto reusada*: esa imagen exacta ya respalda otra evidencia del tenant. No es un error de
  red y **no se reintenta** — reintentar da siempre lo mismo. Hay que pedir una foto nueva.
- **415** = el contenido no corresponde al formato declarado (se valida por bytes, no por el mime).
- **413** = supera el máximo del tenant (`photoMaxSizeMB`), que es configurable y no un número fijo.

La foto de novedad va **después** de crear la novedad, con el id que devolvió el servidor — nunca en
el mismo POST. En terreno una subida cortada se llevaría también el reporte, que es lo que importa.

#### Ver una foto

Los listados devuelven metadatos, **no bytes ni URLs directas**. Para mostrar una imagen:

```
GET /evidence/photos/:photoId/link        reports:read → { url, expiresAt }
GET /evidence/photos/:photoId?exp&tenant&sig            → los bytes (firma, sin sesión)
GET /evidence/photos/:photoId/integrity   reports:read → { estado, esperado, actual }
```

Pide el enlace y ponlo en el `src` del `<img>`. **Dura 5 minutos**: no lo guardes en estado
persistente ni lo metas en una URL que el usuario pueda compartir. Si la vista queda abierta más de
eso, vuelve a pedirlo — un enlace vencido responde **410**, no 403, justamente para que puedas
distinguir "caducó, pídelo de nuevo" de "esto no es tuyo".

No existe ninguna otra ruta hacia el volumen de evidencia: no hay directorio estático.

`integrity` recalcula el hash del archivo y lo compara con el guardado. Devuelve `intacta`,
`alterada` o `ausente` — y esos tres casos son distintos: el segundo es manipulación y el tercero es
pérdida.

### Escalamiento y eventos

```
GET  /escalation/policies                    tenant:security:manage
PUT  /escalation/policies                    reemplaza el set completo
POST /escalation/notifications/:id/acknowledge   patrols:monitor  ← acuse de recibo
GET  /supervisor/sites/:siteId/events        patrols:monitor  ← novedades y pánico juntos
```

La bandeja de eventos trae `criticality` (`info|baja|media|alta|panico`). **El pánico no es otra
cosa**: es la criticidad máxima de una novedad.

### Geolocalización y consentimiento

```
GET    /geo/patrols/:patrolId/track          patrols:monitor  → traza + distancia y duración
POST   /geo/consent    /  DELETE /geo/consent  /  GET /geo/consent     account:sessions:manage
```

**Sin consentimiento vigente el servidor rechaza la traza con 403.** No es validación de formulario:
es requisito legal en Chile y de Google Play. Si construyes pantalla de consentimiento, el texto debe
decir qué se rastrea, cuándo y por cuánto tiempo (ver `docs/geolocalizacion-y-consentimiento.md`).

### SUPERADMIN — acceso de soporte a una empresa

```
GET    /platform/support-access               platform:support:access  → ventanas vigentes
POST   /platform/support-access               {tenantId, reason, minutes?}
DELETE /platform/support-access/:id           cerrar antes de que venza
```

Así entra el SUPERADMIN a los datos de una empresa: abre una ventana con **motivo escrito** y después
manda la cabecera **`x-support-access-id`** en cada request a ese tenant. La ventana vence sola (tope
8 horas) y el ADMIN de la empresa puede ver quién entró. Si construyes esta pantalla, el motivo es
obligatorio y **no debe tener un valor por defecto**: escribirlo es el punto.

### Panel general
```
GET /dashboard/tenant     tenant:dashboard:read   ← ADMIN y SUPERVISOR
GET /guard/home           patrols:execute         ← solo GUARDIA (móvil)
```

## 6. Convenciones de `apps/web/`

- **Next.js 15, App Router, TypeScript.** Las páginas por rol viven en `apps/web/app/app/[role]/`.
- Los componentes compartidos están en `apps/web/app/_components/`. Mira `dashboard-shell.tsx`
  (navegación por rol), `login-screen.tsx` (cómo se llama a la API) y `session-management.tsx`
  (una tabla real consumiendo endpoints) **antes de inventar tu propio patrón**.
- **Estilos en `apps/web/app/globals.css` con clases planas.** No hay Tailwind ni librería de
  componentes, y no la agregues sin acordarlo con el equipo: el bundle importa (ver punto 8).
- Tipos compartidos con el backend: **`@sentrycore/shared`** (roles, permisos, reglas, entidades del
  dominio). Si necesitas un tipo que ya vive ahí, impórtalo — no lo redeclares.
- `npm run typecheck` y `npm run build` tienen que pasar. `tsconfig` está en modo estricto con
  `noUncheckedIndexedAccess`: indexar un arreglo devuelve `T | undefined` y hay que manejarlo.

## 7. Cómo trabajar (el flujo del equipo)

```
feature/<numero>-<slug>  ──►  staging  ──►  main
```

1. **Asígnate el issue en GitHub antes de empezar.** Si no está asignado, está libre. Esta regla
   existe porque ya pasó que dos personas implementaron lo mismo sin saberlo.
2. Rama por issue, con el número: `feature/100-gestion-usuarios`.
3. PR **siempre hacia `staging`**, nunca a `main`. Cierra el issue con `Closes #100` en la
   descripción.
4. La CI corre 6 checks y **tienen que estar verdes**. Cada push a `staging` despliega al VPS: si
   rompes staging, rompes el ambiente de pruebas de todo el equipo.
5. Si tocas `packages/shared`, pide revisión de **dos** personas: ese paquete rompe a los otros tres.

## 8. Trampas de este carril (ahorra tiempo leyéndolas)

**El SUPERVISOR no ve todos los recintos.** Un `403` de `/supervisor/...` no es un bug: es el alcance
por recinto funcionando. La interfaz debe mostrar solo los recintos asignados y manejar el rechazo.

**Los datos son de otra empresa hasta que se demuestre lo contrario.** El aislamiento se aplica en la
base de datos, pero la interfaz nunca debe asumir que un id que recibió por parámetro es visible.
Maneja el 403 y el 404 como estados normales, no como errores de programación.

**No guardes el token en `localStorage`.** Las cookies son `HttpOnly` a propósito; si escribes código
que intenta leerlas o guardar credenciales en el navegador, estás rompiendo el modelo de seguridad.

**Nada de datos personales en logs ni en la URL.** Ni nombres de guardias, ni correos, ni
ubicaciones. Es requisito legal, no estilo.

**Ojo con el peso del bundle.** La misma interfaz web se muestra dentro de un WebView en teléfonos de
gama baja que la empresa le entrega al guardia. Una librería de componentes de 300 kB se paga en
segundos de carga en terreno.

**Las reglas de negocio no se codifican.** Si te encuentras escribiendo `if (cumplimiento < 70)` en
un componente, para: ese 70 sale de `GET /rules/admin`. El siguiente cliente querrá 85.

**El mapa es OpenStreetMap, no Google.** Leaflet o MapLibre. Y `tile.openstreetmap.org` **no sirve en
producción** (su política lo prohíbe y bloquea): hay que usar un proveedor con capa gratuita o servir
tiles propios. Es una decisión abierta — háblala antes de cablear una URL de tiles.

## 9. Los 10 issues de este carril

**Panel de ADMIN** (épica #3): `#100` usuarios · `#101` recintos, sucursales y puntos ·
`#102` configuración de reglas · `#103` macro-estadísticas · `#104` auditoría.

**Panel de SUPERVISOR** (épica #4): `#95` editor de rutas sobre mapa · `#96` programación de turnos ·
`#97` monitoreo en vivo · `#98` alertas de ronda vencida o con anomalías · `#99` estadísticas e
informes de sus recintos.

Cada issue tiene su propio objetivo y criterios de aceptación en GitHub. **Orden sugerido**: `#101`
primero (sin recintos y puntos no hay nada que mostrar en el resto), después `#100` y `#102`, luego
los del supervisor.

**Lo que todavía no existe en la API** y hay que coordinar antes de empezarlo: la auditoría de
acciones (`#104`) y algunas métricas consolidadas (`#103`, `#99`) necesitan endpoints nuevos. Si tu
issue necesita un dato que no está en la sección 5, **dilo en el issue antes de escribir código** —
alguien del carril de backend lo agrega. No inventes el endpoint ni hagas cálculos en el navegador
que deberían venir resueltos del servidor.
