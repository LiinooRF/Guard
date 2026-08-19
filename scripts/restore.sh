#!/bin/sh
# ---------------------------------------------------------------------------
# Script de host para restaurar la base de datos de SentryCore (issue #24 / #224).
#
# Soporta volcados planos (.dump) y cifrados (.dump.age, .dump.enc, .dump.gpg).
# Valida la integridad SHA-256 automáticamente si existe el archivo .sha256.
#
# Uso:
#   ./scripts/restore.sh /backups/sentrycore-2026-08-03.dump sentrycore_restore
#   ./scripts/restore.sh /backups/sentrycore-2026-08-03.dump.enc sentrycore_restore
# ---------------------------------------------------------------------------
set -eu

COMPOSE_FILE="docker-compose.dokploy.yml"

if [ "$#" -lt 2 ]; then
  echo "Uso: $0 <ruta-al-dump-en-contenedor-o-host> <base-destino-vacia> [--compose <compose-file>]"
  echo "Ejemplo: $0 /backups/sentrycore-2026-08-03.dump sentrycore_restore"
  exit 1
fi

DUMP="$1"
DB="$2"
shift 2

while [ "$#" -gt 0 ]; do
  case "$1" in
    --compose|-f)
      COMPOSE_FILE="$2"
      shift 2
      ;;
    *)
      echo "Parametro desconocido: $1" >&2
      exit 1
      ;;
  esac
done

if [ ! -f "$COMPOSE_FILE" ]; then
  if [ -f "docker-compose.production.yml" ]; then
    COMPOSE_FILE="docker-compose.production.yml"
  elif [ -f "docker-compose.yml" ]; then
    COMPOSE_FILE="docker-compose.yml"
  fi
fi

echo "== Restaurando base de datos $DB desde $DUMP con $COMPOSE_FILE =="
docker compose -f "$COMPOSE_FILE" exec postgres-backup sh /scripts/restore.sh "$DUMP" "$DB"
