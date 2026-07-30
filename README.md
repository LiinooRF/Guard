# VoxIA Control

SaaS multi-tenant white-label de **monitoreo de rondas de vigilancia con etiquetas NFC**.

El guardia recorre puntos de control, escanea la etiqueta NFC de cada uno, fotografía los accesos
críticos, y al escanear el último punto el informe se genera y se envía **automáticamente**. Si el
cumplimiento baja del umbral configurado, el informe va directo al admin de la empresa.

El backlog completo son **19 épicas y 100 sub-tareas** en los
[issues](https://github.com/4l4h3rg4/Guard/issues).

> **Antes de escribir código, lee [CLAUDE.md](./CLAUDE.md).** Es el contexto completo del proyecto:
> el modelo de dominio, las decisiones ya tomadas, las trampas del rubro (por qué el NFC no funciona
> en un WebView, por qué la ruta "óptima" es un riesgo de seguridad, por qué las fotos no pueden venir
> de la galería) y las cinco reglas que no se negocian. Sirve igual para personas y para agentes de IA.

> **Nombre del producto vs nombre del repo.** El producto es **VoxIA Control**. El repositorio
> todavía se llama `Guard`, que fue el nombre de trabajo inicial. Renombrarlo requiere permisos de
> admin y está en la lista de pendientes al final de este archivo. `Guard` aparece solo en la URL de
> clonado: dentro del código no queda ninguna referencia.

---

## Arrancar (día 1)

Requisitos: **Node 22+**, **Docker Desktop**, **git**.

```bash
git clone https://github.com/4l4h3rg4/Guard.git voxia-control
cd voxia-control

cp .env.example .env      # PowerShell: Copy-Item .env.example .env
npm install

npm run infra:up          # postgres + redis + mailpit
npm run build             # compila @voxia/shared, que api y web importan

npm run dev:api           # http://localhost:3001/health
npm run dev:web           # http://localhost:3000
```

Si `http://localhost:3000` muestra la tabla de roles y de reglas, el monorepo está bien conectado.

| Servicio | Dónde |
|---|---|
| Panel web | http://localhost:3000 |
| API | http://localhost:3001/health · http://localhost:3001/api/rules/defaults |
| Correo de pruebas | http://localhost:8025 |
| PostgreSQL | `localhost:5432` |
| Redis | `localhost:6379` |

### Por qué la api y la web no están en el compose

El `docker-compose.yml` levanta **solo la infraestructura** (PostgreSQL, Redis, Mailpit). La API y la
web se corren nativas con `npm run dev:*`.

Montar `node_modules` por bind mount en Windows es lento y rompe binarios nativos. Correr las apps
nativas da recarga en caliente instantánea. Las imágenes reales de producción las construye Dokploy a
partir de los Dockerfiles, que son parte del issue #6.

---

## Estructura

```
voxia-control/
├─ apps/
│  ├─ api/          NestJS — la API que consumen web y móvil
│  ├─ web/          Next.js — paneles de SUPERADMIN, ADMIN y SUPERVISOR
│  └─ mobile/       Expo — la app del guardia (la inicializa Dev C, ver su README)
├─ packages/
│  └─ shared/       roles, entidades del dominio y reglas configurables
├─ docker/
│  └─ postgres/     script que crea el rol de aplicación sin BYPASSRLS
├─ docker-compose.yml
└─ .github/workflows/ci.yml
```

**`packages/shared` es la razón de que esto sea un monorepo.** Roles, tipos del dominio y reglas de
negocio viven en un solo lugar, así que el contrato entre backend, web y móvil no se desincroniza. Si
cambias algo ahí, **rompes a los otros tres** — por eso el PR pide revisión de dos personas.

`apps/mobile` queda **fuera de los workspaces de npm** a propósito: Metro, el bundler de Expo, no se
lleva bien con el hoisting de `node_modules`. Ver `apps/mobile/README.md`.

---

## Los 4 roles

Rol y plataforma son **ejes separados**: el rol define permisos, la plataforma es consecuencia de la
tarea.

| Rol | Quién es | Entra desde | Alcance |
|---|---|---|---|
| `SUPERADMIN` | dueño de la plataforma | desktop | **cruza tenants**: empresas, licencias, white-label |
| `ADMIN` | la empresa cliente | desktop | su tenant: usuarios, recintos, reglas, macro-estadísticas |
| `SUPERVISOR` | jefe directo | **app + desktop** | sus recintos: rutas y turnos (desktop), monitoreo (app) |
| `GUARDIA` | quien hace la ronda | **solo app** | su ronda del turno |

---

## Stack y decisiones

| Área | Decisión |
|---|---|
| API | NestJS |
| Web | Next.js (App Router) |
| Móvil | Expo + React Native WebView, Android, publicación en Google Play |
| Datos | PostgreSQL con `tenant_id` + **RLS** en una sola base |
| Cache y colas | Redis — sesiones, refresh tokens, rate limiting, BullMQ |
| Infra | VPS con Docker, orquestado por **Dokploy** |
| Etiquetas | **NFC** (13.56 MHz), con QR como respaldo |
| Mapas | **OpenStreetMap** (no Google Maps: sin tarjeta de crédito ni factura sorpresa) |
| Correo | interfaz `MailProvider`; **el proveedor concreto está sin decidir** (issue #9) |

### Tres cosas que hay que saber antes de escribir código

1. **El NFC no funciona dentro del WebView.** La Web NFC API existe en Chrome para Android pero no
   está expuesta en el componente WebView. El escaneo es nativo (`react-native-nfc-manager`) y viaja
   al WebView por `postMessage`. El puente es núcleo del producto, no un accesorio. Implica
   development build: **Expo Go no sirve**. → issue #11

2. **Todo lo del guardia tiene que funcionar sin conexión.** Las rondas ocurren en subterráneos y
   perímetros sin señal. Si un escaneo necesita internet, el producto no sirve en producción.
   → issue #14

3. **Ninguna regla de negocio va fija en el código.** El 70% de cumplimiento y la foto obligatoria
   fuera de horario son el default de *un* cliente, no la ley del producto. Todo parámetro vive en
   `packages/shared/src/rules.ts` y se sobreescribe por tenant. → issue #16

---

## Ramas

```
feature/12-motor-rondas ──┐
feature/11-escaneo-nfc  ──┼──►  staging  ──►  main
feature/6-docker        ──┘     (VPS test)    (producción)
```

Rama por issue, PR siempre hacia `staging`. Detalles en [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## Estado de verificación de este scaffolding

Sé honesto con lo que está probado y lo que no:

| | Estado |
|---|---|
| `npm install` del workspace | **verificado** — 603 paquetes, sin errores |
| `npm run typecheck` (shared + api + web) | **verificado** — sin errores |
| `npm run build` (shared + api + web) | **verificado** — los tres compilan |
| `docker compose up` | **sin verificar** — Docker Desktop estaba apagado al momento de armarlo |
| API respondiendo en runtime | **sin verificar** |
| `apps/mobile` | **sin verificar** — lo inicializa Dev C, ver su README |

---

## Pendiente de `4l4h3rg4` (requiere permisos de admin)

Lo siguiente no se puede hacer con acceso de `write`:

- [ ] **Renombrar el repo de `Guard` a `voxia-control`.** GitHub deja redirecciones automáticas, así
      que no rompe los clones existentes.
- [ ] **Migrar el repo a una organización de GitHub.** Hoy vive en una cuenta personal: si esa cuenta
      se pierde o la persona se va, se va el producto. Una organización gratuita da repos privados
      ilimitados, equipos y secretos compartidos. Conviene hacerlo junto con el renombrado.
- [ ] **Invitar al 4º desarrollador.** Hoy están `4l4h3rg4`, `LiinooRF` y `BrunoAle-115`.
- [ ] **Proteger `main` y `staging`**: exigir PR, exigir CI verde, prohibir force-push.
- [ ] **Crear los Environments** `staging` y `production` con sus secretos.
- [ ] Activar borrado automático de ramas al mergear.
- [ ] Completar `.github/CODEOWNERS` con los usuarios reales.
