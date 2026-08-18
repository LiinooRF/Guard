#!/bin/sh
# ---------------------------------------------------------------------------
# UN respaldo completo de SentryCore (issue #24). Base + fotos + copia FUERA
# del VPS + retencion. Procedimiento completo: docs/respaldos.md.
#
# Este script es el respaldo de verdad: `respaldo-diario.sh` solo lo llama a la
# hora que corresponde, y la prueba de CI lo ejecuta tal cual. Si se cambia algo
# aca, cambia en los tres lugares a la vez, que es justamente la idea.
#
# Uso a mano en el VPS:
#   docker compose -f docker-compose.dokploy.yml exec postgres-backup \
#     sh /scripts/respaldar-una-vez.sh
#
# Que hace, en orden:
#   1. pg_dump -Fc de la base a /backups/sentrycore-AAAA-MM-DD.dump, escribiendo a
#      *.part y renombrando al final: un corte a mitad de dump nunca deja un
#      archivo con nombre valido.
#   2. Lee el indice del dump recien escrito con `pg_restore -l`. Un dump
#      truncado se detecta HOY, no la noche que haya que restaurarlo.
#   3. Copia el dump FUERA del VPS con rclone y comprueba que el tamaño del
#      archivo remoto coincide con el local. Copiar sin verificar no prueba nada.
#   4. Copia la evidencia fotografica fuera del VPS, incremental. Es `rclone
#      copy`, no `sync`: NUNCA borra en el destino (ver docs/respaldos.md).
#   5. Retencion local: borra los dumps mas viejos que BACKUP_RETENTION_DAYS,
#      con dos frenos (abajo). La copia remota NO se borra desde aca.
#
# Entorno:
#   PGHOST/PGUSER/PGPASSWORD/PGDATABASE   dueño de la base. sentrycore_app NO sirve:
#                                         RLS falla cerrada y el dump saldria
#                                         vacio.
#   BACKUP_DIR              default /backups
#   EVIDENCE_DIR            default /evidencia   (volumen de fotos, montado :ro)
#   BACKUP_RETENTION_DAYS   default 30
#   BACKUP_MINIMO_LOCAL     default 3   piso duro: la retencion nunca deja
#                                       menos de estos dumps en el disco, por
#                                       viejos que sean todos
#   BACKUP_REMOTE           destino rclone BASE, ej. r2:sentrycore-respaldos
#                           vacio = NO hay copia fuera del VPS (se reporta)
#   BACKUP_REMOTE_POSTGRES  default "$BACKUP_REMOTE/postgres"
#   BACKUP_REMOTE_EVIDENCIA default "$BACKUP_REMOTE/evidencia"
#   BACKUP_COPIAR_EVIDENCIA default si
#
# Codigos de salida (los lee el monitoreo, no solo una persona):
#   0  base y copias fuera del VPS confirmadas
#   1  NO hay dump del dia: es la falla grave
#   2  hay dump local, pero la copia fuera del VPS no se pudo confirmar
# ---------------------------------------------------------------------------
set -eu

ETIQUETA_LOG=respaldo
. "$(dirname "$0")/comun.sh"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
EVIDENCE_DIR="${EVIDENCE_DIR:-/evidencia}"
RETENCION="${BACKUP_RETENTION_DAYS:-30}"
MINIMO_LOCAL="${BACKUP_MINIMO_LOCAL:-3}"
REMOTO_BASE="${BACKUP_REMOTE:-}"
# Sin la barra final: rclone la agrega y "destino//archivo" crea una carpeta
# vacia en S3.
REMOTO_BASE="${REMOTO_BASE%/}"
REMOTO_PG="${BACKUP_REMOTE_POSTGRES:-${REMOTO_BASE:+$REMOTO_BASE/postgres}}"
REMOTO_EV="${BACKUP_REMOTE_EVIDENCIA:-${REMOTO_BASE:+$REMOTO_BASE/evidencia}}"
COPIAR_EVIDENCIA="${BACKUP_COPIAR_EVIDENCIA:-si}"

FECHA=$(date +%F)
ARCHIVO="sentrycore-$FECHA.dump"
DESTINO="$BACKUP_DIR/$ARCHIVO"
ESTADO="$BACKUP_DIR/estado-respaldo.txt"

PROBLEMAS_REMOTO=0

if [ -z "${PGDATABASE:-}" ]; then
  registrar_error "PGDATABASE no esta definida: no se sabe que base respaldar"
  exit 1
fi

exigir_binarios pg_dump pg_restore || exit 1

if [ ! -d "$BACKUP_DIR" ]; then
  registrar_error "no existe $BACKUP_DIR (¿falta el volumen backup_data?)"
  exit 1
fi

# ---------------------------------------------------------------------------
# 1 y 2. Dump de la base y lectura de su indice
# ---------------------------------------------------------------------------
INICIO_DUMP=$(date +%s)
registrar "pg_dump de '$PGDATABASE' -> $DESTINO"

if ! pg_dump -Fc -f "$DESTINO.part" "$PGDATABASE"; then
  rm -f "$DESTINO.part"
  registrar_error "pg_dump fallo; queda el dump anterior y se reintenta mañana"
  printf '%s|FALLIDO|pg_dump\n' "$FECHA" >> "$ESTADO"
  exit 1
fi

# Un dump que no se puede ni indexar no se va a poder restaurar. Barato: lee la
# tabla de contenidos, no los datos.
if ! pg_restore -l "$DESTINO.part" > /dev/null 2>&1; then
  rm -f "$DESTINO.part"
  registrar_error "el dump quedo ilegible (pg_restore -l lo rechaza); se descarta"
  printf '%s|FALLIDO|dump-ilegible\n' "$FECHA" >> "$ESTADO"
  exit 1
fi

mv "$DESTINO.part" "$DESTINO"
SEGUNDOS_DUMP=$(($(date +%s) - INICIO_DUMP))
BYTES_DUMP=$(wc -c < "$DESTINO" | tr -d ' ')
registrar "dump listo: $(du -h "$DESTINO" | cut -f1) ($BYTES_DUMP bytes) en ${SEGUNDOS_DUMP}s"

# Generar checksum de integridad SHA256
generar_checksum "$DESTINO"

# Cifrado opcional (age / openssl / gpg)
HERRAMIENTA_CIFRADO=$(detectar_herramienta_cifrado)
DESTINO_SUBIR="$DESTINO"
ARCHIVO_SUBIR="$ARCHIVO"
BYTES_SUBIR="$BYTES_DUMP"

if [ "$HERRAMIENTA_CIFRADO" != "none" ]; then
  EXT_CIFRADO=$(extension_cifrado "$HERRAMIENTA_CIFRADO")
  DESTINO_CIFRADO="$DESTINO$EXT_CIFRADO"
  ARCHIVO_CIFRADO="$ARCHIVO$EXT_CIFRADO"
  registrar "cifrando dump con $HERRAMIENTA_CIFRADO -> $ARCHIVO_CIFRADO"
  if cifrar_archivo "$DESTINO" "$DESTINO_CIFRADO" "$HERRAMIENTA_CIFRADO"; then
    generar_checksum "$DESTINO_CIFRADO"
    BYTES_CIFRADO=$(wc -c < "$DESTINO_CIFRADO" | tr -d ' ')
    registrar "dump cifrado con exito ($BYTES_CIFRADO bytes)"
    DESTINO_SUBIR="$DESTINO_CIFRADO"
    ARCHIVO_SUBIR="$ARCHIVO_CIFRADO"
    BYTES_SUBIR="$BYTES_CIFRADO"
    # Si no se pide conservar el dump en texto plano local, se descarta por seguridad
    if [ "${BACKUP_KEEP_LOCAL_PLAINTEXT:-no}" != "si" ]; then
      rm -f "$DESTINO" "$DESTINO.sha256"
    fi
  else
    registrar_error "fallo el cifrado con $HERRAMIENTA_CIFRADO; se aborta subida por seguridad"
    printf '%s|FALLIDO|cifrado-%s\n' "$FECHA" "$HERRAMIENTA_CIFRADO" >> "$ESTADO"
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# 3. El dump, fuera del VPS
# ---------------------------------------------------------------------------
if [ -z "$REMOTO_PG" ]; then
  registrar_error "BACKUP_REMOTE vacio: el dump quedo SOLO en el disco del VPS."
  registrar_error "Si se pierde el VPS, se pierde el respaldo. Ver docs/respaldos.md."
  PROBLEMAS_REMOTO=$((PROBLEMAS_REMOTO + 1))
elif ! command -v rclone > /dev/null 2>&1; then
  registrar_error "hay BACKUP_REMOTE pero falta rclone en la imagen del servicio"
  PROBLEMAS_REMOTO=$((PROBLEMAS_REMOTO + 1))
else
  INICIO_SUBIDA=$(date +%s)
  registrar "copiando el dump a $(redactar_remoto "$REMOTO_PG")"
  if ejecutar_rclone copy "$DESTINO_SUBIR" "$REMOTO_PG/" && { [ ! -f "$DESTINO_SUBIR.sha256" ] || ejecutar_rclone copy "$DESTINO_SUBIR.sha256" "$REMOTO_PG/"; }; then
    SEGUNDOS_SUBIDA=$(($(date +%s) - INICIO_SUBIDA))
    # Copiar y no mirar es la forma clasica de tener un respaldo remoto vacio.
    BYTES_REMOTO=$(tamano_remoto "$REMOTO_PG" "$ARCHIVO_SUBIR")
    if [ -z "$BYTES_REMOTO" ]; then
      registrar_error "el dump no aparece en el destino remoto despues de copiarlo"
      PROBLEMAS_REMOTO=$((PROBLEMAS_REMOTO + 1))
    elif [ "$BYTES_REMOTO" != "$BYTES_SUBIR" ]; then
      registrar_error "tamaño distinto: local $BYTES_SUBIR bytes, remoto $BYTES_REMOTO bytes"
      PROBLEMAS_REMOTO=$((PROBLEMAS_REMOTO + 1))
    else
      registrar "copia fuera del VPS confirmada: $BYTES_REMOTO bytes en ${SEGUNDOS_SUBIDA}s"
    fi
  else
    registrar_error "rclone no pudo copiar el dump fuera del VPS"
    PROBLEMAS_REMOTO=$((PROBLEMAS_REMOTO + 1))
  fi
fi

# ---------------------------------------------------------------------------
# 4. La evidencia fotografica, fuera del VPS
#
# Incremental y con `copy`, jamas `sync`: las fotos son prueba y no se borran
# desde el VPS. Con `sync`, un borrado accidental en el volumen se propagaria al
# respaldo esa misma noche, que es exactamente el desastre del que protege.
# Contracara honesta: un purge de tenant NO limpia el destino remoto solo. Esta
# escrito en docs/respaldos.md y en docs/borrado-y-exportacion.md.
# ---------------------------------------------------------------------------
if [ "$COPIAR_EVIDENCIA" != "si" ]; then
  registrar_aviso "BACKUP_COPIAR_EVIDENCIA distinto de 'si': las fotos NO se respaldan"
elif [ -z "$REMOTO_EV" ]; then
  registrar_error "sin BACKUP_REMOTE no hay respaldo de la evidencia fotografica"
  PROBLEMAS_REMOTO=$((PROBLEMAS_REMOTO + 1))
elif [ ! -d "$EVIDENCE_DIR" ]; then
  registrar_error "no existe $EVIDENCE_DIR: ¿falta montar el volumen evidence_data?"
  PROBLEMAS_REMOTO=$((PROBLEMAS_REMOTO + 1))
elif ! command -v rclone > /dev/null 2>&1; then
  registrar_error "hay evidencia que copiar pero falta rclone en la imagen del servicio"
  PROBLEMAS_REMOTO=$((PROBLEMAS_REMOTO + 1))
else
  INICIO_EV=$(date +%s)
  registrar "copiando la evidencia a $(redactar_remoto "$REMOTO_EV")"
  if ejecutar_rclone copy "$EVIDENCE_DIR" "$REMOTO_EV/"; then
    SEGUNDOS_EV=$(($(date +%s) - INICIO_EV))
    # `check --one-way` compara hash por archivo del origen contra el destino e
    # ignora lo que sobre en el destino (las fotos de dias anteriores).
    if ejecutar_rclone check "$EVIDENCE_DIR" "$REMOTO_EV/" --one-way > /dev/null 2>&1; then
      registrar "evidencia confirmada fuera del VPS en ${SEGUNDOS_EV}s"
    else
      registrar_error "quedaron fotos sin copiar o con contenido distinto en el destino"
      PROBLEMAS_REMOTO=$((PROBLEMAS_REMOTO + 1))
    fi
  else
    registrar_error "rclone no pudo copiar la evidencia fuera del VPS"
    PROBLEMAS_REMOTO=$((PROBLEMAS_REMOTO + 1))
  fi
fi

# ---------------------------------------------------------------------------
# 5. Retencion local
#
# Solo se llega aca con el dump de HOY ya escrito, y ademas nunca se baja de
# BACKUP_MINIMO_LOCAL dumps.
#
# El minimo se aplica borrando POR EXCESO, no por antiguedad ciega: se calcula
# cuantos dumps sobran por encima del minimo y se borran como mucho esos, del
# mas viejo al mas nuevo. Un `find -mtime "+$RETENCION" -delete` a secas no
# sirve como freno: si el servicio estuvo caido un mes, TODOS los dumps
# superan la retencion y el find los borra de una sola pasada, dejando el VPS
# con el dump de hoy y nada mas.
#
# El orden alfabetico de 'sentrycore-AAAA-MM-DD.dump*' es el orden cronologico —el
# nombre lleva la fecha en ISO—, asi que `sort` alcanza y no hace falta pedirle
# a find una opcion de ordenamiento que busybox no tiene.
#
# La copia remota NO se toca desde aca. La retencion de alla se configura como
# regla de ciclo de vida del proveedor: si este contenedor pudiera borrar en el
# destino, cualquiera que entre al VPS se lleva tambien los respaldos.
# ---------------------------------------------------------------------------
CANTIDAD=$(find "$BACKUP_DIR" -maxdepth 1 \( -name 'sentrycore-*.dump' -o -name 'sentrycore-*.dump.*' \) ! -name '*.sha256' ! -name '*.part' -type f | wc -l | tr -d ' ')
BORRABLES=$((CANTIDAD - MINIMO_LOCAL))
if [ "$BORRABLES" -le 0 ]; then
  registrar "retencion: hay $CANTIDAD dump(s), el minimo es $MINIMO_LOCAL; no se borra nada"
else
  VIEJOS=$(find "$BACKUP_DIR" -maxdepth 1 \( -name 'sentrycore-*.dump' -o -name 'sentrycore-*.dump.*' \) ! -name '*.sha256' ! -name '*.part' -type f -mtime "+$RETENCION" | sort)
  VENCIDOS=0
  BORRADOS=0
  if [ -n "$VIEJOS" ]; then
    # Se parte SOLO por salto de linea, no por espacios: si alguien dejo a mano
    # un archivo con espacios en /backups, partirlo por palabras convertiria un
    # `rm` en otra cosa. `${IFS-}` y no `$IFS` por el `set -u` de arriba.
    IFS_ORIGINAL="${IFS-}"
    IFS='
'
    for VIEJO in $VIEJOS; do
      VENCIDOS=$((VENCIDOS + 1))
      if [ "$BORRADOS" -ge "$BORRABLES" ]; then
        continue
      fi
      rm -f "$VIEJO" "$VIEJO.sha256"
      BORRADOS=$((BORRADOS + 1))
    done
    IFS=$IFS_ORIGINAL
  fi
  QUEDAN=$(find "$BACKUP_DIR" -maxdepth 1 \( -name 'sentrycore-*.dump' -o -name 'sentrycore-*.dump.*' \) ! -name '*.sha256' ! -name '*.part' -type f | wc -l | tr -d ' ')
  if [ "$VENCIDOS" -gt "$BORRADOS" ]; then
    registrar_aviso "retencion: $VENCIDOS dump(s) pasaron los $RETENCION dias pero solo se borraron $BORRADOS; manda el minimo de $MINIMO_LOCAL"
  fi
  registrar "retencion $RETENCION dias: se borraron $BORRADOS, quedan $QUEDAN dumps (habia $CANTIDAD, minimo $MINIMO_LOCAL)"
fi

# Limpieza de checksums huerfanos y temporales
find "$BACKUP_DIR" -maxdepth 1 -name 'sentrycore-*.part' -type f -mtime +1 -delete 2> /dev/null || true

# ---------------------------------------------------------------------------
# Estado, para que el monitoreo no tenga que leer el log
# ---------------------------------------------------------------------------
if [ "$PROBLEMAS_REMOTO" -eq 0 ]; then
  printf '%s|OK|dump=%ss,%sB\n' "$FECHA" "$SEGUNDOS_DUMP" "$BYTES_SUBIR" >> "$ESTADO"
  registrar "respaldo del $FECHA completo (base y copias fuera del VPS)"
  exit 0
fi

printf '%s|PARCIAL|dump-local-ok|sin-copia-remota=%s\n' "$FECHA" "$PROBLEMAS_REMOTO" >> "$ESTADO"
registrar_error "respaldo del $FECHA PARCIAL: hay dump local pero $PROBLEMAS_REMOTO problema(s) con la copia fuera del VPS"
exit 2
