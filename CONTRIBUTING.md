# Cómo trabajamos en SentryCore

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

## Antes de empezar: asígnate el issue

**Si un issue no tiene a nadie asignado, está libre. Si lo vas a tomar, asígnatelo primero.** Es lo
único que impide que dos personas hagan el mismo trabajo, y toma cinco segundos.

Somos 4 sobre 137 issues: nadie puede saber qué estás haciendo si no lo dices en el issue.

## Pull requests

- **Un PR por issue.** Si toca tres áreas sin relación, son tres PR.
- Contra `staging`, nunca contra `main`.
- Cierra el issue con `Closes #11` en la descripción.
- La CI tiene que estar verde: `typecheck`, `build` y `test`.
- Si tocas `packages/shared`, pide revisión a **dos** personas: ese paquete rompe a los otros tres.
- **Revisa los PR de los demás.** Un PR sin revisar bloquea a quien lo escribió y a todo lo que venga
  detrás. Es tan parte del trabajo como escribir código.

### Si tu trabajo va encadenado

A veces un issue depende del anterior y no puedes esperar. Se puede, pero **apunta cada PR a la rama
anterior, no a `staging`**:

```
feature/28-esquema    ──► staging
feature/29-rls        ──► feature/28-esquema     ← no a staging
feature/30-contexto   ──► feature/29-rls
```

Así GitHub muestra en cada PR **solo lo tuyo** en vez de repetir todo lo anterior, y al mergear el
primero re-apunta el siguiente solo.

Si los apuntas todos a `staging`, quien revise el último termina leyendo cuatro veces el mismo código
y hay que mergear en un orden exacto que nadie escribió en ninguna parte.

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

El usuario de aplicación (`sentrycore_app`) **no tiene `BYPASSRLS`** a propósito: si lo tuviera,
PostgreSQL ignoraría las políticas de aislamiento y un `WHERE` olvidado filtraría datos de una
empresa a otra. El script de init falla el arranque si detecta lo contrario.

### Dos roles distintos: uno migra, otro atiende

| Rol | Para qué | Puede crear tablas |
|---|---|---|
| dueño del esquema | correr migraciones | **sí** |
| `sentrycore_app` | la API en runtime | **no** |

La API no necesita poder alterar el esquema, y no debería poder: si alguien la compromete, la
diferencia entre leer datos y poder borrar tablas es esta línea.

Consecuencia práctica: **las migraciones no se conectan con `DATABASE_URL`.** Si `data-source.ts` usa
la misma URL que la app, el primer `CREATE TABLE` se cae con `permission denied for schema public`.

Y ojo con lo contrario: **si la CI corre las migraciones con superusuario y tú en local con el rol
restringido, la CI queda verde y el error aparece en tu máquina.** La CI tiene que usar la misma
separación de roles que usa un desarrollador; si no, prueba una configuración que nadie corre.

### El rol se define en un solo lugar

`docker/postgres/init/01-app-role.sh` es la **única** definición de `sentrycore_app`, y ahí vive la
comprobación que aborta el arranque si el rol quedó con `BYPASSRLS`.

No crees el rol a mano en otro lado —un workflow de CI, un script de setup— aunque parezca más
rápido. Una segunda definición sin esa comprobación deja los tests de aislamiento pasando en verde
mientras el rol real se salta las políticas, que es el peor error posible: el que no se nota.

## Si tocas dependencias (leelo, nos costo dos CI rojas)

Cuando agregues o quites un paquete, **verifica el lockfile con el mismo comando que
usa la CI** antes de subir:

```bash
rm -rf node_modules
npm ci
```

Por que: `npm install` corriendo en Windows o macOS **poda del lockfile entradas que solo
aplican a Linux** (subarboles nativos como `@emnapi/*`) o las mueve de lugar. En tu maquina
todo sigue funcionando porque `node_modules` ya existe; en la CI y en la imagen Docker,
`npm ci` se niega con `Missing: ... from lock file` y falla el build entero.

`npm ci` borra `node_modules` y instala EXACTAMENTE lo que dice el lockfile: si pasa en tu
maquina, pasa en la CI. Regenerar el lockfile desde cero **no** alcanza — produce un arbol
distinto al que ya estaba verde. Si `npm ci` se queja, compara tu lockfile con el de
`staging` y restaura las entradas que npm haya movido o borrado.

## Commits

Formato corto, en imperativo, con el issue al final:

```
agrega puente postMessage entre shell nativo y WebView (#11)
corrige deduplicacion de escaneos al reenviar la cola (#14)
```
