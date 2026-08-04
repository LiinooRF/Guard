# Respaldos de PostgreSQL

Issue #24. Dump diario automatico con retencion local, restore documentado, y una prueba
de restore que **corre sola todas las semanas**. Este documento dice como funciona, donde
quedan los dumps, como se prueba el restore, como leer el resultado y — sin maquillaje —
que queda pendiente.

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

## Los dos scripts

Ambos viven en `docker/postgres/backup/` y el compose monta esa carpeta en `/scripts`
dentro del servicio `postgres-backup`, asi que se corren con `docker compose exec`.

| Script | Para que |
|---|---|
| `restore.sh` | **Recuperar.** Restaura un dump en la base que se le indique. Es el procedimiento del desastre real y tambien el paso de restore de la prueba. |
| `verificar-restore.sh` | **Probar.** Toma un dump, lo restaura en una base vacia con `restore.sh` y **verifica el contenido** del resultado. No recupera nada: es la prueba. |

`verificar-restore.sh` **llama** a `restore.sh`, no lo reimplementa: si el procedimiento
de recuperacion cambia, la prueba prueba el procedimiento nuevo.

## La prueba de restore corre sola

Workflow: **`.github/workflows/backup-restore.yml`** (`Prueba de restore` en la pestaña
Actions). Corre **los lunes 06:17 UTC** (~03:00 de Santiago) y a mano con
**Run workflow**. **No corre en cada push a proposito**: tarda varios minutos y su
resultado no cambia commit a commit.

Cada ejecucion, contra un PostgreSQL limpio y descartable del runner:

1. Levanta `postgres:17-alpine` vacio y crea el rol `voxia_app` **sin BYPASSRLS** (el
   dump trae los `GRANT` pero no los roles: sin ese rol el restore falla).
2. Corre **todas** las migraciones y el **seed** — sin datos, comparar origen con destino
   seria comparar 0 con 0 y pasaria sin probar nada.
3. Llama a `verificar-restore.sh` **dentro de una imagen `postgres:17-alpine`**, la misma
   del servicio de backup. Dos razones: el `pg_dump` del runner es version 16 y se niega a
   dumpear un servidor 17, y asi el dump lo produce el mismo binario que en el VPS.

Un paso aparte compara que `docker-compose.dokploy.yml` y `verificar-restore.sh` sigan
usando el mismo `pg_dump -Fc -f`. Si alguien cambia el comando del servicio y no el de la
prueba, el job falla: una prueba que dumpea distinto que produccion no prueba produccion.

### Que verifica exactamente

No que el comando "no dio error" — `pg_restore` puede terminar habiendo ignorado errores.
Verifica el resultado:

| Verificacion | Por que |
|---|---|
| **Conteo de tablas**, igual en origen y destino, y mayor que cero | Un restore a medias deja menos tablas. |
| **RLS ENABLE + FORCE en toda tabla con `tenant_id`** | Un restore que pierde las politicas es una **fuga de datos esperando**: muchas empresas de seguridad privada comparten esta base. Sin `FORCE`, ademas, el dueño se salta sus propias politicas. |
| **Politicas RLS identicas**, con su `USING` y su `WITH CHECK` | Una politica que sobrevive con la condicion cambiada es peor que una perdida: no se nota. |
| **`app_tenant_id()` y `app_has_audited_support_access()` existen y CORREN** | Las politicas dependen de ellas. Ademas se comprueba que `app_tenant_id()` lee el contexto y que el acceso de soporte **falla cerrado** sin `support_access_id`. |
| **Conteos de filas por tabla**, iguales entre origen y destino | Es la unica forma de saber que los datos llegaron, no solo el esquema. |
| **`GRANT` sobre tablas para `voxia_app`** | Sin ellos la base restaurada existe pero la API no puede leerla. |
| **Indices** | Un restore sin los indices unicos acepta duplicados que el modelo prohibe. |
| **Tiempo de restore** | Criterio del issue: cuanto tarda recuperar la base. |

### Como leer el resultado

El job termina en verde solo si **todas** las verificaciones pasaron. En el resumen del
run (pestaña Actions → la ejecucion → Summary) queda una tabla con tamaño del dump,
**duracion del restore**, tablas, filas, fallas y avisos. En el log, cada verificacion
imprime `[ok]` o `[FALLA]`, y cada falla imprime el **diff entre origen y destino**: esa
es la lista concreta de lo que el restore perdio.

Sobre la duracion: el numero del CI es un **piso**, no el tiempo de recuperacion del VPS.
El runner restaura una base de tamaño seed en disco de CI. Sirve para detectar que el
restore se degrade de segundos a minutos, no para prometer un RTO.

## Correrlo a mano contra el VPS

El mismo script, sin GitHub de por medio:

```bash
# Prueba completa: dump + restore + verificacion, sobre una base de prueba.
# ORIGEN_EN_VIVO=si porque la base productiva sigue recibiendo escrituras: las
# filas que llegan despues del dump no estan en el destino y eso no es un error
# (pg_dump usa un snapshot consistente). Con esa bandera, una diferencia de
# FILAS es aviso; el esquema, RLS y las politicas se siguen exigiendo iguales.
docker compose -f docker-compose.dokploy.yml exec \
  -e ORIGEN_EN_VIVO=si postgres-backup \
  sh /scripts/verificar-restore.sh voxia_verificacion_restore
```

El script se limpia solo: borra la base de prueba y el dump temporal al terminar. Con
`CONSERVAR=si` los deja para inspeccionarlos a mano.

El dump de la prueba se escribe en un temporal, **nunca en `/backups`**: no pisa el dump
del dia ni altera la retencion.

Para **recuperar de verdad** (no probar) se usa el otro script, con un dump ya existente:

```bash
docker compose -f docker-compose.dokploy.yml exec postgres-backup \
  sh /scripts/restore.sh /backups/voxia-2026-08-03.dump voxia_restore

# comparar contra la base viva: migraciones aplicadas
docker compose -f docker-compose.dokploy.yml exec postgres-backup \
  psql -d voxia_restore -qAtc "select count(*) from schema_migrations"

# limpiar
docker compose -f docker-compose.dokploy.yml exec postgres-backup dropdb voxia_restore
```

`restore.sh` se niega a apuntar a la base productiva salvo `CONFIRMO_RESTORE_PRODUCTIVO=si`,
que es el camino del desastre real y no el de una prueba.

## Bitacora de pruebas en entorno limpio

La prueba semanal cubre el **procedimiento y el dump**. Falta anotar aqui las corridas
contra un cluster distinto con datos reales:

| Fecha | Origen | Dump | Tamaño | Duracion restore | Resultado |
|---|---|---|---|---|---|
| _pendiente_ | | | | | |

Como llenarla: copiar un dump del VPS a otro PostgreSQL levantado **con el montaje de
`docker/postgres/init`** (crea `voxia_app`; sin ese rol fallan los `GRANT` y las politicas
del dump), correr `restore.sh` alla, apuntar una API a la base restaurada y verificar login
y una lectura de datos de un tenant. Anotar fecha, tamaño y duracion.

## Que NO cubre, sin maquillaje

- **Un restore verificado en CI no prueba el restore del VPS real.** Prueba el
  procedimiento y el dump: que el comando de respaldo produce un archivo restaurable, que
  `restore.sh` lo restaura, y que lo restaurado conserva esquema, datos, RLS, politicas,
  funciones y permisos. No prueba el disco del VPS, ni su volumen `backup_data`, ni el
  tamaño real de la base, ni que en una emergencia alguien encuentre y ejecute esto a las
  3 de la mañana. Eso se prueba en el VPS y hoy **no esta hecho** (ver la bitacora).
- **Copia FUERA del VPS: sigue sin destino elegido.** `BACKUP_REMOTE` esta en
  `.env.example` y esta **vacia**. Hoy los dumps viven en el **mismo disco** que la base:
  cubren un `DROP TABLE`, una migracion que salio mal o datos corruptos, pero **no** cubren
  que el VPS se pierda entero. La salida es `rclone` hacia S3, Backblaze B2 o Cloudflare R2,
  y exige elegir destino y crear credenciales — decision que no se toma en este issue.
  Cuando se decida, el cambio es acotado: instalar rclone en la imagen del servicio (o un
  sidecar) y agregar `rclone copy /backups "$BACKUP_REMOTE"` despues de cada dump. TODO(#24).
- **La evidencia fotografica**: `pg_dump` respalda la base, no los archivos del
  almacenamiento local (`STORAGE_LOCAL_PATH` / `EVIDENCE_PATH`, en el VPS el volumen
  `evidence_data`). Respaldar ese volumen es trabajo aparte y hoy no esta automatizado: una
  base restaurada apunta a fotos que no existen.
- **Redis**: sesiones y colas no se respaldan a proposito — se regeneran; perderlas obliga a
  re-login, no pierde datos de negocio.
- **Punto de recuperacion**: con un dump diario se puede perder hasta un dia de datos. Si
  algun dia eso no alcanza, lo siguiente es WAL archiving (PITR), que es otro issue.
- **Que el respaldo del dia haya corrido**: el servicio escribe en el log y nadie lo mira.
  No hay alerta si el dump de anoche no existe. Tambien pendiente.
