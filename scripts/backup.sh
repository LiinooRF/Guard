#!/bin/sh
# ---------------------------------------------------------------------------
# Script de host para ejecutar un respaldo manual de SentryCore (issue #24 / #224).
#
# Ejecuta el respaldo completo (PostgreSQL + checksum SHA-256 + cifrado opcional
# + subida fuera del VPS con rclone + evidencia fotografica + retencion local).
#
# Uso:
#   ./scripts/backup.sh
#   ./scripts/backup.sh --compose docker-compose.production.yml
# ---------------------------------------------------------------------------
set -eu

COMPOSE_FILE="docker-compose.dokploy.yml"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --compose|-f)
      COMPOSE_FILE="$2"
      shift 2
      ;;
    -h|--help)
      echo "Uso: $0 [--compose <archivo-compose>]"
      echo "Ejemplo: $0 --compose docker-compose.production.yml"
      exit 0
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
  else
    echo "ERROR: no se encontro $COMPOSE_FILE ni otro archivo compose valido." >&2
    exit 1
  fi
fi

echo "== Ejecutando respaldo manual de SentryCore con $COMPOSE_FILE =="
docker compose -f "$COMPOSE_FILE" exec postgres-backup sh /scripts/respaldar-una-vez.sh
