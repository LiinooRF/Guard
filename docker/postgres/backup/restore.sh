#!/bin/sh
# ---------------------------------------------------------------------------
# Restore de un dump diario de SentryCore (formato custom, pg_dump -Fc).
# Issue #24. Procedimiento completo y como probarlo: docs/respaldos.md.
#
# Uso tipico (en el VPS, con el stack de Dokploy corriendo; el compose monta
# esta carpeta en /scripts dentro del servicio postgres-backup):
#
#   docker compose -f docker-compose.dokploy.yml exec postgres-backup \
#     sh /scripts/restore.sh /backups/sentrycore-2026-08-03.dump sentrycore_restore
#
# Que hace, paso a paso:
#   1. Valida argumentos y que el dump exista y sea un -Fc legible
#      (pg_restore -l lee el indice sin restaurar nada).
#   2. Se niega a apuntar a la base productiva salvo confirmacion explicita
#      (CONFIRMO_RESTORE_PRODUCTIVO=si), que es el camino del desastre real.
#   3. Crea la base destino si no existe. Si existe, exige que este VACIA:
#      restaurar sobre una base con datos mezcla estados y no prueba nada.
#   4. Corre pg_restore --clean --if-exists. Sobre una base vacia los DROP
#      son no-ops gracias a --if-exists; la bandera queda para poder repetir
#      la prueba sobre la misma base sin recrearla.
#   5. Imprime inicio, fin y duracion en segundos: ese numero es el tiempo
#      real de recuperacion de la base y hay que anotarlo en docs/respaldos.md.
#
# Requisitos del entorno donde corre:
#   - PGHOST/PGUSER/PGPASSWORD del DUEÑO de la base (los mismos que usa el
#     servicio postgres-backup). El rol sentrycore_app no sirve: no puede crear
#     bases y RLS le cierra la lectura sin contexto de tenant.
#   - El rol sentrycore_app debe existir en el cluster destino (lo crea
#     docker/postgres/init/01-app-role.sh). Sin el, fallan los GRANT y las
#     politicas del dump. En un cluster levantado con nuestro compose ya esta.
# ---------------------------------------------------------------------------
set -eu

ETIQUETA_LOG=restore
. "$(dirname "$0")/comun.sh"

DUMP="${1:-}"
DB="${2:-}"

if [ -z "$DUMP" ] || [ -z "$DB" ]; then
  echo "uso: restore.sh <ruta-al-dump> <base-destino-vacia>" >&2
  echo "ej.: restore.sh /backups/sentrycore-2026-08-03.dump sentrycore_restore" >&2
  exit 1
fi

if [ ! -f "$DUMP" ]; then
  echo "ERROR: no existe el dump: $DUMP" >&2
  exit 1
fi

if [ "$DB" = "${PGDATABASE:-}" ] && [ "${CONFIRMO_RESTORE_PRODUCTIVO:-no}" != "si" ]; then
  echo "ERROR: '$DB' es la base productiva. Solo para un desastre real:" >&2
  echo "  CONFIRMO_RESTORE_PRODUCTIVO=si sh /scripts/restore.sh $DUMP $DB" >&2
  exit 1
fi

# 1. Verificar integridad (checksum SHA-256) si existe
if [ -f "$DUMP.sha256" ]; then
  verificar_checksum "$DUMP" || exit 1
fi

# 2. Descifrar si el dump viene cifrado (.age, .enc, .gpg)
TRABAJO_RESTORE=""
limpiar_restore() {
  if [ -n "$TRABAJO_RESTORE" ] && [ -d "$TRABAJO_RESTORE" ]; then
    rm -rf "$TRABAJO_RESTORE"
  fi
}
trap limpiar_restore EXIT INT TERM

HERRAMIENTA_DUMP=$(detectar_herramienta_por_archivo "$DUMP")
if [ "$HERRAMIENTA_DUMP" != "none" ]; then
  TRABAJO_RESTORE=$(mktemp -d)
  DUMP_PLANO="$TRABAJO_RESTORE/sentrycore-descomprimido.dump"
  registrar "dump cifrado detectado ($HERRAMIENTA_DUMP); descifrando..."
  if ! descifrar_archivo "$DUMP" "$DUMP_PLANO" "$HERRAMIENTA_DUMP"; then
    echo "ERROR: no se pudo descifrar el dump con $HERRAMIENTA_DUMP (verifique credenciales/claves)" >&2
    exit 1
  fi
  registrar "dump descifrado con exito"
else
  DUMP_PLANO="$DUMP"
fi

if ! pg_restore -l "$DUMP_PLANO" > /dev/null; then
  echo "ERROR: el archivo no es un dump -Fc legible: $DUMP" >&2
  exit 1
fi

if psql -d "$DB" -qAtc "select 1" > /dev/null 2>&1; then
  TABLAS=$(psql -d "$DB" -qAtc "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'")
  if [ "$TABLAS" -ne 0 ] && [ "${CONFIRMO_RESTORE_PRODUCTIVO:-no}" != "si" ]; then
    echo "ERROR: la base '$DB' ya tiene $TABLAS tablas; la prueba exige una base vacia." >&2
    echo "  dropdb '$DB' y volver a correr, o usar otro nombre." >&2
    exit 1
  fi
else
  createdb "$DB"
  echo "base '$DB' creada"
fi

INICIO=$(date +%s)
echo "== RESTORE INICIO $(date '+%F %T') dump=$DUMP destino=$DB =="

pg_restore --clean --if-exists -d "$DB" "$DUMP_PLANO"

FIN=$(date +%s)
echo "== RESTORE FIN $(date '+%F %T') — duracion $((FIN - INICIO)) segundos =="

# Chequeo minimo de que algo se restauro; la verificacion completa (conteos
# contra la base original, RLS activo) esta en docs/respaldos.md.
echo "tablas en public de '$DB':"
psql -d "$DB" -qAtc "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r'"
echo "tablas con RLS FORCE en '$DB':"
psql -d "$DB" -qAtc "select count(*) from pg_class where relrowsecurity and relforcerowsecurity"
