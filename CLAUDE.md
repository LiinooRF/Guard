# Contexto para agentes de IA — VoxIA Control

Este archivo es el contexto que un agente de IA (Claude Code, Cursor, Copilot) debe leer **antes de
tocar código**. Contiene las decisiones ya tomadas, las trampas del dominio y las reglas que no se
negocian.

Si vas a implementar un issue, lee su descripción completa en GitHub: cada épica tiene objetivo,
contexto, criterios de aceptación y dependencias.

---

## Qué es el producto

**SaaS multi-tenant white-label de monitoreo de rondas de vigilancia con etiquetas NFC.**

Un guardia recorre puntos de control físicos. En cada punto hay una etiqueta NFC pegada; el guardia
la toca con el teléfono y eso queda registrado con hora y GPS. En los accesos críticos además debe
fotografiar el estado de la puerta. Al escanear el último punto, la ronda se cierra sola y el informe
en PDF se genera y se envía automáticamente. Si el cumplimiento baja del umbral configurado (70% por
defecto), el informe va directo al admin de la empresa.

**El problema que resuelve**: hoy esto se hace con una planilla de papel que el guardia firma — y que
puede firmar entera sentado en la caseta. La etiqueta NFC obliga a la presencia física.

**Es un SaaS, no un desarrollo a medida.** Muchas empresas usan la misma instancia, cada una con su
marca y sus reglas. Esa distinción gobierna casi todas las decisiones de este documento.

---

## Comandos

```bash
npm install                  # workspace completo (apps/mobile va aparte)
npm run infra:up             # postgres + redis + mailpit en Docker
npm run infra:reset          # BORRA los datos y re-corre los scripts de init
npm run build                # shared -> api -> web, en ese orden
npm run typecheck            # todos los workspaces
npm run dev:api              # http://localhost:3001
npm run dev:web              # http://localhost:3000
```

`packages/shared` se compila **primero**: api y web importan sus tipos. Si cambias algo ahí, recompila
antes de esperar que el resto vea el cambio.

`apps/mobile` está **fuera de los workspaces de npm** a propósito (Metro no se lleva bien con el
hoisting). Se instala aparte. Ver `apps/mobile/README.md`.

---

## Estructura

| Ruta | Qué es |
|---|---|
| `apps/api` | NestJS. La API que consumen web y móvil. |
| `apps/web` | Next.js App Router. Paneles de SUPERADMIN, ADMIN y SUPERVISOR. |
| `apps/mobile` | Expo + React Native WebView. La app del guardia (Android). |
| `packages/shared` | **El contrato común.** Roles, entidades del dominio, reglas configurables. |
| `docker/postgres/init` | Crea el rol de aplicación sin `BYPASSRLS`. |

**`packages/shared` es la razón de que esto sea un monorepo.** Si cambias su API pública, rompes api,
web y móvil a la vez. Trátalo como una interfaz publicada.

---

## Modelo de dominio

```
Tenant (empresa cliente)
  └─ Site (recinto / sucursal)
       └─ Checkpoint (punto de control)  ──  Tag (etiqueta NFC pegada ahí)

Route (secuencia de puntos)
  └─ Shift (ruta + guardia + ventana horaria, con recurrencia)
       └─ Patrol (la ejecución concreta)
            └─ Scan (cada punto escaneado)  ──  Photo (evidencia)
```

Los tipos viven en `packages/shared/src/domain.ts`. Ya incluye lógica de negocio real que **debes
reusar en vez de reimplementar**:

- `computeCompliance()` — calcula el porcentaje y qué puntos faltaron.
- `isPhotoRequired()` — decide si un punto exige foto, considerando horario y criticidad.
- `resolveRules()` en `rules.ts` — resuelve la cascada de configuración.

---

## Los 4 roles

Definidos en `packages/shared/src/roles.ts`.

| Rol | Plataforma | Alcance |
|---|---|---|
| `SUPERADMIN` | desktop | **Cruza tenants.** Es la plataforma, no un cliente: crea empresas, licencias, white-label y el admin de cada cliente. |
| `ADMIN` | desktop | Su tenant: usuarios, recintos, **configuración de reglas**, macro-estadísticas. |
| `SUPERVISOR` | app **y** desktop | Solo **los recintos que tiene asignados**. Desktop para armar rutas y ver estadísticas; app para monitorear en terreno. |
| `GUARDIA` | **solo app** | Solo su ronda del turno. |

**Rol y plataforma son ejes separados.** El rol define permisos; la plataforma es consecuencia de la
tarea. No codifiques "supervisor = app" en el modelo de permisos.

`SUPERVISOR` tiene una restricción extra al rol: está limitado a sus recintos asignados. Eso se
verifica aparte, no alcanza con chequear el rol.

---

## Reglas que no se negocian

### 1. Toda tabla de negocio lleva `tenant_id` y política RLS

Es el requisito de seguridad número uno. Muchas empresas de **seguridad privada** comparten una base:
una fuga cruzada es un incidente grave, no un bug.

El aislamiento se aplica en PostgreSQL (Row Level Security), no solo en el código, para que un `WHERE`
olvidado no filtre datos. El usuario de aplicación (`voxia_app`) **no tiene `BYPASSRLS`** y el script
de init falla el arranque si lo detectara.

> **Trampa concreta**: usa `SET LOCAL app.tenant_id` dentro de transacción, nunca `SET`. Con `SET`, la
> variable queda pegada a la conexión del pool y el siguiente request hereda el tenant anterior.

### 2. La autorización se resuelve en el servidor

Ocultar un botón no es control de acceso. Cada endpoint valida **rol y tenant**. El guard global
deniega por defecto: un endpoint nuevo sin decorador queda cerrado, no abierto.

### 3. Ninguna regla de negocio va fija en el código

El 70% de cumplimiento y la foto obligatoria fuera de horario son **el default de un cliente**, no la
ley del producto. El siguiente cliente va a querer 85% y foto siempre.

Todo parámetro vive en `packages/shared/src/rules.ts` y se resuelve en cascada:

```
plataforma  ->  tenant  ->  recinto  ->  punto     (gana el más específico)
```

Si te encuentras escribiendo un número de negocio en el código, va a `rules.ts`.

### 4. Lo del guardia se prueba sin conexión

Las rondas ocurren en estacionamientos subterráneos, bodegas y perímetros **sin señal**. Si lo probaste
solo con wifi, no está probado. Una ronda completa en modo avión debe registrarse y sincronizar
después sin perder ni un escaneo ni una foto.

### 5. Nada de secretos ni datos de guardias en logs

Ni en el código, ni en los logs, ni en reportes de errores. Los logs llevan `tenant_id` y `request_id`,
no nombres ni ubicaciones de personas.

---

## Trampas del dominio (aprendidas a golpes, no las repitas)

### NFC no funciona dentro de un WebView

La Web NFC API (`NDEFReader`) existe en Chrome para Android pero **no está expuesta en el componente
WebView**. El escaneo tiene que ser nativo (`react-native-nfc-manager`) y viajar al WebView por
`postMessage`.

Consecuencias: el puente nativo es **núcleo del producto**, no un accesorio. Y **Expo Go no sirve** —
hace falta un development build.

### Versiona el protocolo del puente

Los usuarios de Play Store tardan semanas en actualizar la app. Si la web despliega un cambio
incompatible con el puente, les rompes la app en producción y no lo arreglas con un deploy.

### Un Android lee solo NFC, no RFID

NFC son 13.56 MHz. RFID UHF (860-960 MHz) y LF (125 kHz) necesitan **lector externo**. Si el cliente
pide "leer a distancia sin acercar el teléfono", eso es otro hardware, otro presupuesto y otro plazo.

Además: verifica que los teléfonos de los guardias **tengan** NFC. En gama baja a veces no lo tienen, y
eso tumba el diseño completo.

### El fraude de rondas es el problema conocido del rubro

El guardia que se lleva las etiquetas a la caseta y las escanea todas juntas. O que le presta el
teléfono a un compañero. Sin detección de anomalías, el sistema da una **falsa sensación de control**,
que es peor que no tener sistema.

Las marcas están en `scanAnomalySchema`. El sistema **marca y avisa, no rechaza**: descartar
automáticamente castigaría al guardia por un GPS impreciso en un subterráneo, que es una condición
normal de trabajo.

### Las fotos solo se toman con la cámara, nunca de la galería

Si se puede subir desde galería, el guardia fotografía la puerta cerrada una vez y reusa esa imagen
todo el mes. La evidencia deja de valer. No debe existir ninguna ruta en la interfaz para elegir un
archivo.

### La ruta "óptima" es un problema de seguridad, no una virtud

En vigilancia, un guardia que siempre hace el recorrido más eficiente es un guardia **predecible**, y
la predictibilidad es exactamente lo que explota quien quiere entrar: sabe que pasa por la bodega a
las 23:40 y vuelve en 45 minutos.

Por eso existe `randomizeRouteOrder`. **La optimización de rutas (TSP/VRP) se descartó
explícitamente** — era una confusión con logística de paquetería. No la reintroduzcas.

### Los tiles públicos de OpenStreetMap no sirven en producción

`tile.openstreetmap.org` tiene una política de uso que prohíbe el tráfico de aplicaciones reales y
bloquea a quien la incumple. Hay que usar un proveedor con capa gratuita o servir tiles propios. La
atribución a OpenStreetMap es obligatoria por licencia.

### Perder el keystore de Android es irreversible

Sin el keystore no se puede volver a actualizar la app publicada: hay que crear una ficha nueva y
migrar a todos los usuarios a mano. Respaldarlo fuera de Expo es parte del trabajo, no un extra.

### Google Play es riesgo de calendario, no de código

La ubicación en segundo plano es la causa más frecuente de rechazo. La verificación de identidad del
desarrollador y cada revisión tardan **días o semanas**, y no se aceleran con más gente. Ese trámite
empieza el día 1 del proyecto.

### Rastrear a un trabajador tiene requisitos legales

En Chile el monitoreo de ubicación de trabajadores exige aviso previo y proporcionalidad. Hay pantalla
de consentimiento con registro, y **no se rastrea fuera del turno** — y eso tiene que ser demostrable.

### Muchos guardias no tienen correo electrónico

El alta de usuarios no puede depender de que tengan email. Debe existir el camino de credencial
entregada por el admin.

---

## Decisiones ya tomadas (no re-litigar)

| Área | Decisión | Por qué |
|---|---|---|
| Backend | NestJS, separado del panel web | |
| Web | Next.js App Router | |
| Móvil | Expo + RN WebView, **Android** | iOS está fuera de alcance |
| Datos | PostgreSQL, `tenant_id` + RLS en **una sola base** | Schema-por-tenant se descartó por costo de migraciones |
| Cache/colas | Redis: sesiones, refresh tokens, rate limiting, BullMQ | |
| Infra | VPS con Docker, orquestado por **Dokploy** | El VPS es de la empresa |
| Etiquetas | **NFC**, con QR como respaldo marcado | |
| Mapas | **OpenStreetMap** (Leaflet o MapLibre) | Google Maps exige tarjeta de crédito, y dentro de un recinto privado ninguno de los dos tiene datos útiles |
| Correo | Interfaz `MailProvider` + driver `smtp` genérico | Un solo adaptador SMTP cubre cualquier proveedor |
| Optimización de rutas | **Descartada** | Ver "la ruta óptima es un problema de seguridad" |
| Crash reporting | Sentry, opcional y fuera del MVP | |

### Sobre el correo

El proveedor **no está decidido y eso es deliberado**. `MAIL_DRIVER` acepta `mailpit` (desarrollo) y
`smtp` (cualquier servidor real: Postal o Mailu self-hosted, un relay externo, SES). **No agregues un
adaptador por marca** hasta que se decida y exista una razón concreta para usar su API en vez de SMTP.

Cuando se decida, ten presente que enviar directo desde una IP de VPS es el punto frágil: muchos
proveedores bloquean el puerto 25 saliente, y una IP sin historial cae en spam aunque SPF, DKIM, DMARC
y PTR estén perfectos. Un correo de invitación que no llega rompe el onboarding del tenant.

---

## Decisiones abiertas

Están documentadas dentro de sus issues, con opciones y trade-offs. **No las cierres por tu cuenta.**

| Decisión | Issue |
|---|---|
| Proveedor de correo | #9 |
| Modelo de licencias por tenant | #2 |
| Routing de dominio white-label (incluye cómo resuelve el tenant la app móvil, que no tiene barra de direcciones) | #19 |

---

## El backlog

**19 épicas y 100 sub-tareas** en los issues. Las épicas llevan label `epic` y **no se implementan
directo**: agrupan las sub-tareas, que son el trabajo real.

Orden de dependencias — nada arranca antes que #6 y #7:

```
#6 infra ──► #7 datos+RLS ──► #8 sesiones ──► #1 login ──┬─► #3 admin
                          └─► #16 reglas ──► #12 rondas ─┼─► #4 supervisor
                              #10 recintos ─► #11 NFC ───┴─► #5 app guardia
                                             #14 offline
                                             #15 mapas ──► #17 informes
                                                           #18 Play Store
```

Labels: `area:*` (infra, db, auth, api, web, mobile, notif, reports, geo) · `role:*` · `P0|P1|P2` ·
`mvp` · `spike`.

> El label `mvp` está aplicado con criterio "es producto core", **no** "cabe en 4 semanas". Está
> pendiente re-cortarlo.

---

## Ramas y PRs

```
feature/<n>-<slug>  ──►  staging (VPS de pruebas)  ──►  main (producción)
```

Rama por issue, nombrada con el número: `feature/11-escaneo-nfc-nativo`. PR **siempre hacia
`staging`**, nunca a `main`. Cierra el issue con `Closes #11`.

Si tocas `packages/shared`, pide revisión de **dos** personas.

---

## Cómo verificar tu trabajo

Antes de abrir el PR:

1. `npm run typecheck` y `npm run build` pasan.
2. Si tocaste datos: la tabla nueva tiene `tenant_id` y política RLS, y existe un test que prueba que
   el tenant A no lee nada del tenant B.
3. Si tocaste la API: hay test de autorización para el endpoint nuevo, cubriendo los 4 roles y el caso
   cross-tenant.
4. Si tocaste la app: probado **sin conexión**.
5. Si agregaste una regla de negocio: está en `rules.ts`, tiene default y es editable por el admin.

---

## Estado del scaffolding

Lo verificado y lo que no, para que no asumas de más:

| | Estado |
|---|---|
| `npm install`, `typecheck`, `build` de shared/api/web | **verificado** |
| `docker compose up` | **sin verificar** |
| API respondiendo en runtime | **sin verificar** |
| `apps/mobile` | **sin inicializar** — es el primer paso de #18 |

El scaffolding tiene dos endpoints de humo: `/health` y `/api/rules/defaults`. El segundo existe solo
para probar que `@voxia/shared` se resuelve desde la API; se reemplaza al implementar #16.

## Nombre del repo

El producto es **VoxIA Control**. El repositorio todavía se llama `Guard` (nombre de trabajo inicial);
renombrarlo requiere permisos de admin. Dentro del código no queda ninguna referencia al nombre viejo.
