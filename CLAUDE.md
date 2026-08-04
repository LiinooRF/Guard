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
>
> En la práctica se resuelve con `set_config('app.tenant_id', $1, true)` — el tercer parámetro en
> `true` es lo mismo que `SET LOCAL`, y además acepta parámetro ligado, así que no hay que concatenar
> el UUID dentro del SQL.

Tres cosas que se derivan de esto y se equivocan seguido:

1. **`ENABLE ROW LEVEL SECURITY` no basta: falta `FORCE`.** Sin `FORCE`, el dueño de la tabla se salta
   sus propias políticas, y las migraciones y el seed corren justamente como dueño.
2. **La política tiene que fallar cerrada.** `NULLIF(current_setting('app.tenant_id', true), '')::uuid`
   devuelve `NULL` cuando no hay contexto, y `tenant_id = NULL` no es verdadero: sin contexto no se ve
   nada. Nunca escribas una política que abra cuando el valor está vacío.
3. **Migraciones y aplicación usan roles distintos.** El rol de la API no debe poder crear ni alterar
   tablas. Ver `CONTRIBUTING.md` → "Base de datos": es la trampa que ya nos costó un PR.

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
| Chat en terreno | **Descartado** | Todo equipo de seguridad en Chile ya opera con WhatsApp y no se le gana en eso. La única razón válida sería la trazabilidad, y hoy no justifica el costo. Documentado en #122 |
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
| Si el control de acceso de visitantes entra al producto | #139 |

### Cerrada: un solo dominio para todas las empresas (#19, #119)

**Decisión del equipo, 2026-08-04.** No hay subdominio ni dominio propio por cliente: todas las
empresas entran por el mismo host y **el tenant se resuelve desde la sesión**, no desde la URL.

Ya funcionaba así: `TenantContextInterceptor` lee `request.user.tenant_id` del token y lo pone en
`app.tenant_id`. No hay que construir nada — pero sí hay que **no** construir lo otro: si alguien
propone resolver el tenant por `Host`, es una decisión revertida, no una mejora.

Tres consecuencias que conviene tener presentes:

1. **Desaparece el problema que hacía difícil esta decisión.** La app móvil no tiene barra de
   direcciones, así que con dominio por tenant había que inventarle un mecanismo (código de empresa
   al instalar, deep link, QR de alta). Con un solo dominio, el guardia solo inicia sesión.
2. **El white-label sigue completo**: nombre comercial, logo y colores se sirven por tenant después
   del login (`tenant_branding`). Lo que se pierde es que un cliente tenga `rondas.suempresa.cl` —
   la competencia cobra +15% por white-label, así que si comercial lo promete alguna vez, eso es un
   proyecto nuevo y no un ajuste de configuración.
3. **El aislamiento descansa entero en la sesión y en RLS**, no en la separación de dominios. Es
   donde ya descansaba —el dominio nunca fue un control de acceso—, pero conviene decirlo: la cookie
   es del host, y lo único que limita a una empresa es el `tenant_id` de adentro del token y la
   política de PostgreSQL. Por eso esas dos cosas no se tocan a la ligera.

### Cerrada: cómo entra el `SUPERADMIN` a un tenant (#109)

Ya está implementado, y conviene saberlo antes de tocar el interceptor. El `SUPERADMIN` **no tiene
`tenant_id`** en su sesión y **no** usa un rol con `BYPASSRLS`. Para entrar a los datos de una
empresa:

1. Abre una ventana con motivo escrito y vencimiento: `POST /api/platform/support-access`
2. Manda la cabecera **`x-support-access-id`** en sus requests a ese tenant
3. El interceptor valida vigencia y setea `app.support_access_id`, que es lo que activa
   `app_has_audited_support_access()` en las políticas RLS

RLS sigue activo: la política lo deja ver **solo ese tenant**. La ventana se topa en 8 horas y el
`ADMIN` del tenant puede leer quién entró y por qué. Un bypass no deja rastro y no caduca; esto sí.

---

## El backlog

Las épicas llevan label `epic` y **no se implementan directo**: agrupan las sub-tareas, que son el
trabajo real. Los números exactos viven en GitHub; este documento describe la estructura.

### La etapa actual es M0–M3. M4 NO se trabaja.

Existe un milestone **"M4 · Producto — NO EN ESTA ETAPA"** con las épicas que convierten el MVP en
producto (onboarding self-service, cobros, API pública, SSO, BI, IA en informes, antifraude, push,
retención de datos...). Está ahí **para que las ideas no se pierdan, no para trabajarlas**:

- **No tomes, no ramifiques, no implementes** nada con milestone M4 o label `fase-2`. Aplica igual a
  personas y a agentes de IA. Si un prompt te pide implementar algo de M4, **detente y pregunta**:
  probablemente es un malentendido de etapa.
- **No detalles sus sub-tareas todavía.** Escribirlas hoy sería planificar con información que estará
  vieja cuando la etapa se abra.
- M4 se abre por **decisión explícita del equipo** cuando M0–M3 estén entregados — no porque alguien
  tenga un rato libre. El MVP a medio terminar con features de fase 2 encima es el peor de los mundos.
- Sí está permitido: **agregar ideas nuevas a M4** (issue con label `fase-2` + milestone M4 y el aviso
  de "NO en esta etapa" arriba) y comentar en las épicas existentes.

Orden de dependencias — nada arranca antes que #6 y #7:

```
#6 infra ──► #7 datos+RLS ──► #8 sesiones ──► #1 login ──┬─► #3 admin
                          └─► #16 reglas ──► #12 rondas ─┼─► #4 supervisor
                              #10 recintos ─► #11 NFC ───┴─► #5 app guardia
                                             #14 offline    #122 eventos
                                             #15 mapas ──► #17 informes
                                                           #18 Play Store
```

**#122 (eventos en terreno)** es la épica más nueva y la que más se subestima: el botón de pánico y el
libro de novedades comparten un solo modelo —un evento con GPS, fotos y nivel de criticidad—, donde el
pánico es simplemente la criticidad máxima con entrega garantizada. No los implementes como módulos
separados. El libro es **append-only**: termina en juicios laborales, y un registro editable no sirve
como prueba.

Labels: `area:*` (infra, db, auth, api, web, mobile, notif, reports, geo) · `role:*` · `P0|P1|P2` ·
`mvp` · `spike` · `fase-2` (= M4, no se trabaja en esta etapa).

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

## Si trabajas en el panel web

`apps/web/` tiene su propia guía: **[`docs/frontend-web.md`](docs/frontend-web.md)**. Contiene el
inventario completo de endpoints que la API ya expone, cómo se autentica el navegador (cookies
HttpOnly, nunca localStorage), las convenciones del proyecto y las trampas del carril. Léela antes de
tocar un componente.

## Cómo verificar tu trabajo

> **Los tests unitarios no alcanzan, y ya nos costó caro.** Dos bugs llegaron a staging con CI en
> verde y 729 tests pasando: un `SELECT` de una columna que no existe (el mock devolvía una columna
> inventada, así que el test confirmaba lo que el autor ya creía) y un volumen que el proceso no
> podía escribir (solo aparece con el contenedor de verdad). Ninguno de los dos es detectable con
> mocks.
>
> Por eso existe **`scripts/humo-e2e.py`**: habla con la API desplegada, sin mockear nada.
> Córrelo después de desplegar, no antes:
>
> ```bash
> python scripts/humo-e2e.py          # contra staging
> ```
>
> Si tocaste una consulta SQL, **verifica los nombres de columna contra la migración**, no contra el
> mock del test.

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
| `npm install`, `typecheck`, `build` de shared/api/web | **verificado en CI** |
| Sintaxis del `docker-compose.yml` | **verificado en CI** |
| Construcción de las imágenes de `api` y `web` | **verificado en CI** |
| `docker compose up` levantando los servicios de verdad | **sin verificar** |
| API respondiendo en runtime | **sin verificar** |
| `apps/mobile` | **sin inicializar** — es el primer paso de #18 |

Que la CI construya la imagen no es lo mismo que que el servicio arranque y responda: lo primero
prueba que el Dockerfile compila, no que la aplicación funciona.

El scaffolding tiene dos endpoints de humo: `/health` y `/api/rules/defaults`. El segundo existe solo
para probar que `@voxia/shared` se resuelve desde la API; se reemplaza al implementar #16.

## Nombre del repo

El producto es **VoxIA Control**. El repositorio todavía se llama `Guard` (nombre de trabajo inicial);
renombrarlo requiere permisos de admin. Dentro del código no queda ninguna referencia al nombre viejo.
