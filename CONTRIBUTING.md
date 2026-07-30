# Cómo trabajamos en VoxIA Control

Somos 4 sobre un monorepo con un plazo corto. Estas reglas existen para que no nos pisemos, no por
ceremonia.

## Ramas

```
feature/12-motor-rondas ──┐
feature/11-escaneo-nfc  ──┼──►  staging  ──►  main
feature/6-docker        ──┘     (VPS test)    (producción)
```

| Rama | Qué es |
|---|---|
| `main` | Producción. Solo llega desde `staging`, y solo probado. |
| `staging` | Integración. Se despliega al VPS de pruebas. **Todos los PR van acá.** |
| `feature/<n>-<slug>` | Una rama por issue. |

```bash
git switch staging && git pull
git switch -c feature/11-escaneo-nfc-nativo
```

Nunca trabajes directo sobre `staging` ni `main`.

## Pull requests

- **Un PR por issue.** Si toca tres áreas sin relación, son tres PR.
- Contra `staging`, nunca contra `main`.
- Cierra el issue con `Closes #11` en la descripción.
- La CI tiene que estar verde: `typecheck`, `build` y `test`.
- Si tocas `packages/shared`, pide revisión a **dos** personas: ese paquete rompe a los otros tres.

## Los 4 carriles del mes 1

Elegidos para que se bloqueen lo menos posible:

| Dev | Área | Issues |
|---|---|---|
| **A** | Plataforma | #6 infra Docker/Dokploy · #7 datos + RLS · #9 correo |
| **B** | Auth y web | #8 sesiones · #1 login 4 roles · #3 panel admin |
| **C** | Móvil | #11 escaneo NFC · #14 offline · #5 app del guardia · #18 Expo y Play Store |
| **D** | Dominio | #10 recintos · #12 rondas · #16 reglas · #15 mapas · #17 informes |

### Dos cosas que arrancan el día 1, no la semana 4

1. **El trámite de Google Play** (#18). La verificación de identidad del desarrollador y cada revisión
   de Google tardan días o semanas de *calendario*, y no se aceleran con más gente. Si empieza el día
   25, no hay lanzamiento el día 30.
2. **El spike de NFC** (#10). Antes de comprar una sola etiqueta hay que confirmar que el cliente no
   necesita RFID de largo alcance (ningún celular lo lee) y que los teléfonos de los guardias tienen
   NFC. Si eso falla, se cae el diseño completo.

### La primera semana, 3 de 4 están bloqueados

Hasta que Dev A termine infra y base de datos no hay dónde correr nada. Esos días se usan en spikes,
diseño de pantallas y scaffolding, no en esperar.

## Reglas de código que sí revisamos

1. **Toda tabla de negocio lleva `tenant_id` y política RLS.** El aislamiento entre empresas es el
   requisito de seguridad número uno; una fuga cruzada entre clientes de seguridad privada es un
   incidente grave, no un bug.
2. **Autorización en el servidor.** Ocultar un botón no es control de acceso. Cada endpoint valida
   rol *y* tenant.
3. **Ninguna regla de negocio fija en el código.** El 70% de cumplimiento y la foto obligatoria fuera
   de horario son el default de *un* cliente. Todo parámetro va a `packages/shared/src/rules.ts`.
4. **Lo del guardia se prueba sin conexión.** Si solo lo probaste con wifi, no está probado.
5. **Nada de secretos ni datos de guardias** en el código, en los logs ni en los reportes de errores.

## Base de datos

```bash
npm run infra:up       # levantar
npm run infra:reset    # BORRA los datos y vuelve a correr los scripts de init
```

El usuario de aplicación (`voxia_app`) **no tiene `BYPASSRLS`** a propósito: si lo tuviera,
PostgreSQL ignoraría las políticas de aislamiento y un `WHERE` olvidado filtraría datos de una
empresa a otra. El script de init falla el arranque si detecta lo contrario.

## Commits

Formato corto, en imperativo, con el issue al final:

```
agrega puente postMessage entre shell nativo y WebView (#11)
corrige deduplicacion de escaneos al reenviar la cola (#14)
```
