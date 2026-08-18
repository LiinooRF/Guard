# Respaldos de PostgreSQL y de la evidencia fotográfica

Issue #24. Respaldo diario automático, **copia fuera del VPS**, retención de 30 días, restore
documentado y una prueba de restore que **corre sola todas las semanas** y termina arrancando
la API contra la base restaurada. Este documento dice cómo funciona, dónde quedan las copias,
cómo se restaura, cómo se lee el resultado y — sin maquillaje — qué queda pendiente.

> **Lo primero, porque es lo que se olvida**: un respaldo que vive en el mismo disco que la base
> no protege del incendio, del borrado de la cuenta ni del secuestro del VPS. Sirve para un
> `DROP TABLE` o una migración que salió mal, y nada más. Por eso `BACKUP_REMOTE` no es opcional:
> sin ella el servicio respalda igual, pero **avisa en cada corrida y termina con código 2**.

## Cómo funciona

El servicio `postgres-backup` de `docker-compose.dokploy.yml` corre **igual en staging y en
producción** (no tiene perfil a propósito: el respaldo no es opcional) y vive solo en la red
interna. Su imagen es `docker/postgres/backup/Dockerfile`: `postgres:17-alpine` más `rclone`.

El contenedor ejecuta `respaldo-diario.sh`, que es **solo el reloj**. Cada día a las **04:00 de
America/Santiago** llama a `respaldar-una-vez.sh`, que es el respaldo de verdad:

1. `pg_dump -Fc` con las credenciales del **dueño** (`POSTGRES_USER`). No puede usar `sentrycore_app`:
   RLS falla cerrada y sin contexto de tenant el dump saldría vacío. Escribe a `*.part` y renombra
   al terminar, así un corte a mitad de dump nunca deja un archivo con nombre válido.
2. **Lee el índice del dump recién escrito** con `pg_restore -l`. Un dump truncado se descubre esa
   misma noche y no la madrugada en que haya que restaurarlo.
3. **Copia el dump fuera del VPS** con rclone y **comprueba que el tamaño del archivo remoto
   coincide con el local**. Copiar sin mirar es la forma clásica de tener un respaldo remoto vacío.
4. **Copia la evidencia fotográfica fuera del VPS**, incremental, y la verifica con `rclone check`.
5. Aplica la retención local: borra los dumps de más de `BACKUP_RETENTION_DAYS` días, **pero nunca
   deja menos de `BACKUP_MINIMO_LOCAL` (3)**. El mínimo se aplica borrando *por exceso* —cuántos
   dumps sobran por encima del piso, del más viejo al más nuevo— y no como un simple `find -mtime
   -delete`, que el día que el servicio estuvo caído un mes encuentra **todos** los dumps vencidos y
   los borra de una sola pasada.

Que el respaldo sea un script y no un `command:` escrito dentro del compose es a propósito: el
respaldo automático, el que se corre a mano y el que prueba la CI son **literalmente el mismo
archivo**. Si alguien cambia el procedimiento, cambia en los tres lugares a la vez.

Si al arrancar el contenedor todavía no existe el dump del día, respalda de inmediato en vez de
esperar a mañana (`BACKUP_AL_ARRANCAR`). Sin eso, un redeploy a las 04:05 se comía el respaldo del
día entero y nadie se enteraba.

### La hora y el cambio de hora

El objetivo diario se calcula sumando **un día de calendario a la fecha sin zona** y recién después
convirtiendo a la zona del contenedor. **No** se suman 86.400 segundos al timestamp: en Chile el
reloj se mueve en septiembre y en abril, y esos dos días del año el respaldo se correría a las 03:00
o a las 05:00. Es la misma trampa que las reglas del producto tienen con la zona horaria del recinto.

`pruebas-comun.sh` lo comprueba dentro de la imagen: recorre un año de saltos de 04:00 a 04:00 y
exige que cada uno dure 23, 24 o 25 horas exactas. Un salto de 48 horas sería un día sin respaldo.
También falla si la imagen se quedara sin `tzdata`, porque entonces "las 04:00" serían UTC, o sea
medianoche en Chile y en plena ronda.

## Dónde quedan las copias

| Qué | Dónde | Retención |
|---|---|---|
| Dump diario | volumen `backup_data` (`/backups/sentrycore-AAAA-MM-DD.dump`) | `BACKUP_RETENTION_DAYS`, **30 días**, con piso de `BACKUP_MINIMO_LOCAL` (3) dumps |
| Dump diario | `BACKUP_REMOTE/postgres/` — **fuera del VPS** | regla del proveedor (ver abajo) |
| Evidencia fotográfica | `BACKUP_REMOTE/evidencia/` — **fuera del VPS** | **no se borra nunca** |
| Estado de la última corrida | `/backups/estado-respaldo.txt` | — |

```bash
# listar los dumps locales
docker compose -f docker-compose.dokploy.yml exec postgres-backup ls -lh /backups

# ver cómo terminaron las últimas corridas
docker compose -f docker-compose.dokploy.yml exec postgres-backup tail /backups/estado-respaldo.txt
```

OJO: `docker compose down -v` borra `backup_data` junto con todos los dumps locales. Igual que con
`postgres_data`: no usar `-v` en un entorno con datos. La copia de fuera del VPS sobrevive a eso,
que es justamente para lo que está.

## Configurar la copia fuera del VPS

`BACKUP_REMOTE` es un destino de **rclone**, que habla S3, Backblaze B2, Cloudflare R2, SFTP y
bastante más. **El proveedor no está decidido y este issue no lo decide**: el mismo criterio que con
el correo (#9): la interfaz es genérica y elegir después no cuesta nada. Lo que sí está decidido es
que la copia existe.

Las credenciales van en variables `RCLONE_CONFIG_<NOMBRE>_*` del gestor de secretos de Dokploy,
**nunca dentro de `BACKUP_REMOTE`**. Ejemplo con Cloudflare R2, con el destino llamado `r2`:

```bash
BACKUP_REMOTE=r2:sentrycore-respaldos
RCLONE_CONFIG_R2_TYPE=s3
RCLONE_CONFIG_R2_PROVIDER=Cloudflare
RCLONE_CONFIG_R2_ENDPOINT=https://<cuenta>.r2.cloudflarestorage.com
RCLONE_CONFIG_R2_REGION=auto
RCLONE_CONFIG_R2_ACCESS_KEY_ID=<clave>
RCLONE_CONFIG_R2_SECRET_ACCESS_KEY=<secreto>
```

Backblaze B2 y AWS S3 son lo mismo cambiando `PROVIDER` y `ENDPOINT`.

Si alguien igual pasa una cadena de conexión en línea (`:s3,access_key_id=...:balde`), los scripts
**la redactan antes de imprimirla**: en el log queda `:s3,(parametros ocultos):balde`. Es la regla de
no poner secretos en los logs, aplicada al caso en que la configuración *es* el secreto.

### La retención remota se configura en el proveedor, no acá

Los scripts **no borran nada en el destino remoto**, y no es un olvido: si este contenedor pudiera
borrar allá, cualquiera que entre al VPS se lleva también los respaldos. Un ransomware que cifra el
VPS y además borra el bucket deja la empresa sin nada.

La retención de 30 días del destino remoto se configura como **regla de ciclo de vida del
proveedor** (S3 Lifecycle, B2 Lifecycle Rules, R2 Object Lifecycle) sobre el prefijo
`postgres/`, y **nunca sobre `evidencia/`**. Lo ideal es además activar versionado con bloqueo de
objetos, que es lo que convierte el respaldo en algo que ni un atacante con acceso al VPS puede
borrar. La CI verifica que ningún script haya adquirido un `rclone sync|delete|purge` con el tiempo.

## La evidencia fotográfica

`pg_dump` respalda la base, no los archivos. Una base restaurada sin las fotos entrega informes con
la ronda completa y la evidencia rota, que frente a un juicio laboral es peor que no tener nada.

Se copia con **`rclone copy`, jamás `sync`**: nunca borra en el destino. Es incremental —las fotos
son inmutables, se escriben una vez y no se tocan—, así que cada noche solo viaja lo nuevo. Con
`sync`, un borrado accidental en el volumen se propagaría al respaldo esa misma noche, que es
exactamente el desastre del que protege.

**Contracara honesta**: como no borra, un purge de tenant (ver `docs/borrado-y-exportacion.md`) **no
limpia la copia remota de sus fotos**. Esa nota de aquel documento —"los dumps siguen conteniendo al
tenant hasta que rote la retención"— **no vale para la evidencia**, que no rota. Borrar el prefijo
del tenant en el destino es hoy un paso manual:

```bash
docker compose -f docker-compose.dokploy.yml exec postgres-backup \
  sh -c 'rclone purge "$BACKUP_REMOTE/evidencia/<tenant_id>"'
```

**El `sh -c '...'` con comillas simples no es cosmético.** `BACKUP_REMOTE` vive en el entorno del
contenedor, no en el de la shell del VPS: sin envolverlo, la variable se expande a **vacío** antes de
entrar y el comando queda como `rclone purge "/evidencia/<tenant_id>"`, que apunta al **volumen de
evidencia en uso**, no al destino remoto. Hoy no destruye nada porque ese volumen se monta `:ro`,
pero si alguien lo corre después de remontarlo con escritura para restaurar fotos (más abajo), borra
evidencia de producción en vez de la copia remota. Antes de dejarlo en un runbook, correrlo una vez
contra el destino real con `rclone lsd` en lugar de `purge` y mirar qué lista.

Automatizarlo es trabajo aparte y **no está hecho**.

## Los scripts

Todos viven en `docker/postgres/backup/` y el compose monta esa carpeta en `/scripts` dentro del
servicio, así que se corren con `docker compose exec`.

| Script | Para qué |
|---|---|
| `respaldo-diario.sh` | El reloj. Es el `command` del servicio. Espera la hora y llama al de abajo. |
| `respaldar-una-vez.sh` | **El respaldo.** Base + evidencia + copia fuera del VPS + retención. |
| `verificar-copia-remota.sh` | **¿Existe el respaldo de ayer fuera del VPS?** La pregunta que importa. |
| `restore.sh` | **Recuperar la base.** El procedimiento del desastre real y el paso de restore de la prueba. |
| `restaurar-evidencia.sh` | **Recuperar las fotos.** La otra mitad del restore. |
| `verificar-restore.sh` | **Probar.** Restaura en una base vacía y **verifica el contenido**. No recupera nada. |
| `pruebas-comun.sh` | Pruebas de las funciones compartidas (fechas, zona horaria, redacción de secretos). |
| `comun.sh` | Funciones compartidas. No se ejecuta solo. |

`verificar-restore.sh` **llama** a `restore.sh`, no lo reimplementa: si el procedimiento de
recuperación cambia, la prueba prueba el procedimiento nuevo.

## La prueba de restore corre sola

Workflow: **`.github/workflows/backup-restore.yml`** (`Prueba de restore` en la pestaña Actions).
Corre **los lunes 06:17 UTC** (~03:00 de Santiago), a mano con **Run workflow**, y en los PR que
toquen los scripts de respaldo.

En los PR corre **solo el job liviano** (`scripts`): sintaxis, ShellCheck, construcción de la imagen
y `pruebas-comun.sh` dentro de ella. Un error de tipeo en un script de respaldo no puede esperar
hasta el lunes, pero la cadena completa tarda varios minutos y su resultado no cambia commit a
commit.

### La cadena completa (job `restore`)

Contra un PostgreSQL y un Redis limpios y descartables del runner:

1. Levanta la base, crea el rol `sentrycore_app` **sin BYPASSRLS** (el dump trae los `GRANT` pero no los
   roles: sin ese rol el restore falla), corre **todas** las migraciones y el **seed**.
2. Inventa evidencia fotográfica, haciendo de volumen `evidence_data`.
3. **Respalda con `respaldar-una-vez.sh`**, el script del servicio, dentro de la imagen del servicio.
4. Comprueba con `verificar-copia-remota.sh` que el dump quedó fuera del VPS.
5. **Baja el dump desde el destino remoto** y restaura **ese archivo**. Es la diferencia entre "el
   respaldo se puede restaurar" y "la copia que está fuera del VPS se puede restaurar", que es la
   que importa el día malo.
6. Verifica el contenido de lo restaurado (tabla de abajo).
7. **Restaura la evidencia** desde el destino remoto y la compara **byte a byte** (sha256) con la
   original.
8. **Arranca la API contra la base restaurada** y comprueba `/health`, `/ready` —que consulta
   PostgreSQL y Redis de verdad— y un **login real** con los usuarios que venían en el respaldo.
   La API se conecta como `sentrycore_app`, el rol restringido: si el restore hubiera perdido los `GRANT`
   o las políticas, se cae acá.

Un paso aparte compara que el `pg_dump` del servicio y el de la prueba sigan siendo el mismo. Si
alguien cambia uno y no el otro, el job falla: una prueba que respalda distinto que producción no
prueba producción.

### El job `copia-fuera-del-vps`

Levanta un **MinIO** (habla el protocolo de S3) y hace el viaje completo contra un almacén de
objetos real: respalda, comprueba y trae la evidencia de vuelta para compararla. Prueba el mismo
camino que usarían B2, R2 o S3. Va aparte del job de restore para que un problema del almacenamiento
no tape el resultado de la prueba de restore, que es la que no puede quedar sin respuesta.

### Qué verifica exactamente el restore

No que el comando "no dio error" — `pg_restore` puede terminar habiendo ignorado errores. Verifica
el resultado:

| Verificación | Por qué |
|---|---|
| **Conteo de tablas**, igual en origen y destino, y mayor que cero | Un restore a medias deja menos tablas. |
| **RLS ENABLE + FORCE en toda tabla con `tenant_id`** | Un restore que pierde las políticas es una **fuga de datos esperando**: muchas empresas de seguridad privada comparten esta base. Sin `FORCE`, además, el dueño se salta sus propias políticas. |
| **Políticas RLS idénticas**, con su `USING` y su `WITH CHECK` | Una política que sobrevive con la condición cambiada es peor que una perdida: no se nota. |
| **`app_tenant_id()` y `app_has_audited_support_access()` existen y CORREN** | Las políticas dependen de ellas. Se comprueba que la primera lee el contexto y que el acceso de soporte **falla cerrado**. |
| **Lectura real con el rol `sentrycore_app`**: con contexto ve lo de su tenant y nada de los otros; **sin contexto no ve nada** | Todo lo anterior mira el catálogo. Esto lee datos como los lee la API. Se hace con `SET LOCAL ROLE` porque el dueño de la base es superusuario y el superusuario **se salta RLS entero**: "probar" el aislamiento con el mismo usuario que hace el dump daría verde siempre. |
| **Conteos de filas por tabla**, iguales entre origen y destino | Es la única forma de saber que los datos llegaron, no solo el esquema. |
| **`GRANT` sobre tablas para `sentrycore_app`** | Sin ellos la base restaurada existe pero la API no puede leerla. |
| **Índices** | Un restore sin los índices únicos acepta duplicados que el modelo prohíbe. |
| **Las fotos, byte a byte** | El respaldo de la base no las cubre. |
| **Que la API arranque encima** | Criterio del issue. Lo demás prueba el archivo; esto prueba el producto. |
| **Tiempo de restore** | Criterio del issue: cuánto tarda recuperar la base. |

### Cómo leer el resultado

El job termina en verde solo si **todas** las verificaciones pasaron. En el resumen del run
(Actions → la ejecución → Summary) queda una tabla con tamaño del dump, **duración del restore**,
tablas, filas, fallas, avisos y si la API arrancó. En el log, cada verificación imprime `[ok]` o
`[FALLA]`, y cada falla imprime el **diff entre origen y destino**: esa es la lista concreta de lo
que el restore perdió.

Sobre la duración: el número de la CI es un **piso**, no el tiempo de recuperación del VPS. El
runner restaura una base de tamaño seed en disco de CI. Sirve para detectar que el restore se degrade
de segundos a minutos, no para prometer un RTO.

## Correrlo a mano contra el VPS

```bash
# ¿hay respaldo de ayer fuera del VPS? (la pregunta de las 3 de la mañana)
docker compose -f docker-compose.dokploy.yml exec postgres-backup \
  sh /scripts/verificar-copia-remota.sh

# respaldar ahora, sin esperar a las 04:00
docker compose -f docker-compose.dokploy.yml exec postgres-backup \
  sh /scripts/respaldar-una-vez.sh

# prueba completa: dump + restore + verificación, sobre una base de prueba
docker compose -f docker-compose.dokploy.yml exec \
  -e ORIGEN_EN_VIVO=si postgres-backup \
  sh /scripts/verificar-restore.sh sentrycore_verificacion_restore
```

`ORIGEN_EN_VIVO=si` porque la base productiva sigue recibiendo escrituras: las filas que llegan
después del dump no están en el destino y eso no es un error (`pg_dump` usa un snapshot consistente).
Con esa bandera, una diferencia de **filas** es aviso; el esquema, RLS y las políticas se siguen
exigiendo iguales.

El script se limpia solo: borra la base de prueba y el dump temporal al terminar. Con `CONSERVAR=si`
los deja para inspeccionarlos. El dump de la prueba se escribe en un temporal, **nunca en
`/backups`**: no pisa el dump del día ni altera la retención.

### Recuperar de verdad

```bash
# 1. la base, desde un dump ya existente
docker compose -f docker-compose.dokploy.yml exec postgres-backup \
  sh /scripts/restore.sh /backups/sentrycore-2026-08-03.dump sentrycore_restore

# si el dump ya no está en el disco local, primero se baja del destino remoto.
# El sh -c con comillas SIMPLES es obligatorio: BACKUP_REMOTE existe dentro del
# contenedor, no en la shell del VPS. Sin él la ruta queda "/postgres/..." y el
# comando falla justo el día que hace falta.
docker compose -f docker-compose.dokploy.yml exec postgres-backup \
  sh -c 'rclone copy "$BACKUP_REMOTE/postgres/sentrycore-2026-08-03.dump" /backups/'

# 2. las fotos
docker compose -f docker-compose.dokploy.yml exec postgres-backup \
  sh /scripts/restaurar-evidencia.sh /evidencia-restore

# 3. comprobar y limpiar
docker compose -f docker-compose.dokploy.yml exec postgres-backup \
  psql -d sentrycore_restore -qAtc "select count(*) from schema_migrations"
docker compose -f docker-compose.dokploy.yml exec postgres-backup dropdb sentrycore_restore
```

`restore.sh` se niega a apuntar a la base productiva salvo `CONFIRMO_RESTORE_PRODUCTIVO=si`, y
`restaurar-evidencia.sh` se niega a escribir sobre la evidencia en uso con la misma bandera. Es el
camino del desastre real, no el de una prueba.

> **Para restaurar la evidencia sobre el volumen que usa la API** hay que montarlo con escritura: en
> el compose, `postgres-backup` lo monta `:ro` a propósito, porque el respaldo no tiene por qué poder
> escribir en la evidencia.

## Bitácora de restores medidos

La prueba semanal mide el tiempo de restore en el runner y lo publica en el resumen del run. Falta
anotar acá las corridas **contra el VPS**, que es el número que sirve para prometer un tiempo de
recuperación:

| Fecha | Origen | Tamaño del dump | Duración restore base | Duración restore fotos | ¿Arrancó la app? | Resultado |
|---|---|---|---|---|---|---|
| _pendiente_ | | | | | | |

Cómo llenarla: correr `verificar-restore.sh` y `restaurar-evidencia.sh` en el VPS, apuntar una API a
la base restaurada, verificar login y una lectura de datos de un tenant, y anotar los números que
imprimen los scripts.

## Qué NO cubre, sin maquillaje

- **Nadie ha corrido esto contra el VPS todavía.** Los scripts se probaron con binarios simulados y
  la cadena completa se prueba en CI, pero **la primera corrida real está pendiente** y la bitácora
  de arriba está vacía. Hasta que esa fila tenga números, el tiempo de recuperación es una
  estimación, no un dato.
- **Un restore verificado en CI no prueba el restore del VPS real.** Prueba el procedimiento, el
  dump y la copia remota: que el respaldo produce un archivo restaurable, que lo restaurado conserva
  esquema, datos, RLS, políticas, funciones y permisos, y que la API arranca encima. No prueba el
  disco del VPS, ni el tamaño real de la base, ni que en una emergencia alguien encuentre y ejecute
  esto a las 3 de la mañana.
- **El proveedor de almacenamiento no está probado.** La CI usa MinIO, que habla S3. Las credenciales
  reales, la latencia real y la factura del proveedor que se elija son otra cosa.
- **El purge de un tenant no limpia sus fotos del destino remoto.** Es manual (arriba está el
  comando) y debería ser un issue aparte.
- **Redis**: sesiones y colas no se respaldan a propósito — se regeneran; perderlas obliga a
  re-login, no pierde datos de negocio.
- **Punto de recuperación**: con un dump diario se puede perder hasta un día de datos. Si algún día
  eso no alcanza, lo siguiente es WAL archiving (PITR), que es otro issue.
- **Nadie recibe un aviso si el respaldo de anoche falló.** El servicio termina con código 2 y lo
  escribe en el log y en `estado-respaldo.txt`, y `verificar-copia-remota.sh` contesta la pregunta
  cuando alguien la hace. Pero **no hay alerta que llegue sola**: engancharla al canal de avisos
  (`docs/operations/observability.md`) sigue pendiente y es lo más importante que falta.
