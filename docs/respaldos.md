# Respaldos de PostgreSQL

Issue #24. Dump diario automatico con retencion local y restore documentado y medible.
Este documento dice como funciona, donde quedan los dumps, como probar el restore de
punta a punta, y — sin maquillaje — que queda pendiente.

## Como funciona

El servicio `postgres-backup` de `docker-compose.dokploy.yml` es un contenedor
`postgres:17-alpine` que corre **igual en staging y produccion** (no tiene perfil a
proposito: el respaldo no es opcional) y vive solo en la red interna. En loop:

1. Duerme hasta las **04:00 de America/Santiago** (si ya paso la hora, hasta las
   04:00 del dia siguiente).
2. Corre `pg_dump -Fc` contra el servicio `postgres` con las credenciales del
   **dueño** (`POSTGRES_USER`). No puede usar `voxia_app`: RLS falla cerrada y sin
   contexto de tenant el dump saldria vacio. Escribe primero a `*.part` y renombra
   al terminar, asi un corte a mitad de dump nunca deja un archivo con nombre valido.
3. Borra los dumps mas antiguos que `BACKUP_RETENTION_DAYS` dias.

El formato custom (`-Fc`) va comprimido y se restaura con `pg_restore`, incluso por
partes (`--table`, `--schema-only`) si algun dia hace falta.

## Donde quedan

En el volumen Docker `backup_data`, montado en `/backups` del contenedor, con nombre
`voxia-YYYY-MM-DD.dump` (un dump por dia; si el servicio se reinicia y vuelve a correr
el mismo dia, sobreescribe el de esa fecha).

```bash
# listar los dumps
docker compose -f docker-compose.dokploy.yml exec postgres-backup ls -lh /backups

# copiar uno fuera del contenedor (al disco del VPS o via ssh a tu maquina)
docker compose -f docker-compose.dokploy.yml cp postgres-backup:/backups/voxia-2026-08-03.dump .
```

OJO: `docker compose down -v` borra `backup_data` junto con todos los dumps. Igual que
con `postgres_data`: no usar `-v` en un entorno con datos.

## Retencion

`BACKUP_RETENTION_DAYS`, default **14** (documentada en `.env.example`; en staging y
produccion se fija en Dokploy). Despues de cada dump se borran los `voxia-*.dump` con
mas dias que ese umbral. Ajustarla es cambiar la variable y redeployar, no tocar codigo.

## Como probar el restore de punta a punta

El script es `docker/postgres/backup/restore.sh`, montado en `/scripts` dentro del
servicio `postgres-backup`. Restaura con `pg_restore --clean --if-exists` sobre una
base **vacia** y se niega a apuntar a la productiva salvo confirmacion explicita
(`CONFIRMO_RESTORE_PRODUCTIVO=si`, el camino del desastre real).

Prueba dentro del mismo cluster (valida el dump y mide el tiempo):

```bash
# 1. Elegir el dump mas reciente
docker compose -f docker-compose.dokploy.yml exec postgres-backup ls -lh /backups

# 2. Restaurar a una base de prueba (el script la crea si no existe)
docker compose -f docker-compose.dokploy.yml exec postgres-backup \
  sh /scripts/restore.sh /backups/voxia-2026-08-03.dump voxia_restore

# 3. Anotar la duracion que imprime el script ("duracion N segundos"):
#    ese numero es el tiempo real de recuperacion de la base y va en la
#    bitacora de abajo.

# 4. Verificar contenido comparando contra la base original:
#    mismas migraciones aplicadas...
docker compose -f docker-compose.dokploy.yml exec postgres-backup \
  psql -d voxia_restore -qAtc "select count(*) from migrations"
#    ...y mismas tablas con RLS activo y forzado (el script ya imprime ambos
#    conteos al final; deben calzar con los de la base productiva).

# 5. Limpiar
docker compose -f docker-compose.dokploy.yml exec postgres-backup dropdb voxia_restore
```

La prueba **de verdad** — la que cierra el issue — es en un entorno limpio, porque un
restore dentro del mismo cluster no prueba el escenario "el VPS murio":

1. Levantar un PostgreSQL nuevo (otro VPS, o local con `docker-compose.yml`) **con el
   montaje de `docker/postgres/init`**: el init crea el rol `voxia_app`; sin ese rol
   los `GRANT` y las politicas RLS del dump fallan.
2. Copiar alla un dump real y correr `restore.sh` contra ese cluster.
3. Apuntar una API a la base restaurada y verificar login y una lectura de datos de
   un tenant.
4. Anotar aqui fecha, tamaño del dump y duracion.

**Nota honesta**: esa prueba en entorno limpio esta escrita pero **pendiente de
ejecutarse**. El issue #24 **NO se cierra** hasta correrla y llenar esta bitacora. Un
respaldo que nunca se restauro es una esperanza, no un respaldo.

| Fecha | Dump | Tamaño | Duracion restore | Resultado |
|---|---|---|---|---|
| _pendiente_ | | | | |

## Copia FUERA del VPS — decision abierta (TODO)

Hoy los dumps viven en el **mismo disco** que la base: cubren un `DROP TABLE`, una
migracion que salio mal o datos corruptos, pero **no** cubren que el VPS se pierda
entero. La salida es `rclone` hacia un almacenamiento externo (S3, Backblaze B2 o
Cloudflare R2), y eso exige elegir destino y crear credenciales — decision que no se
toma en este issue.

Queda parametrizado con `BACKUP_REMOTE` en `.env.example` (**vacia = solo local**, el
estado actual). Cuando se decida el destino, el cambio es acotado: instalar rclone en
la imagen del servicio de backup (o un sidecar) y agregar un
`rclone copy /backups "$BACKUP_REMOTE"` despues de cada dump. TODO(#24).

## Que NO cubre, sin maquillaje

- **Copia fuera del VPS**: pendiente de decision (ver arriba). Mientras tanto, disco
  del VPS perdido = respaldos perdidos.
- **La prueba real de restore en entorno limpio**: escrita, no ejecutada. El issue
  queda abierto hasta hacerla.
- **La evidencia fotografica**: `pg_dump` respalda la base, no los archivos del
  almacenamiento local (`STORAGE_LOCAL_PATH`). Respaldar ese volumen es trabajo
  aparte y hoy no esta automatizado.
- **Redis**: sesiones y colas no se respaldan a proposito — se regeneran; perderlas
  obliga a re-login, no pierde datos de negocio.
- **Punto de recuperacion**: con un dump diario se puede perder hasta un dia de
  datos. Si algun dia eso no alcanza, lo siguiente es WAL archiving (PITR), que es
  otro issue.
