#!/bin/sh
# ---------------------------------------------------------------------------
# Script de host para verificar el procedimiento de restore (issue #24 / #224).
#
# Realiza dump -> restore en base de prueba -> verificacion exhaustiva
# (RLS ENABLE y FORCE, politicas, aislamiento multi-tenant con sentrycore_app,
# funciones, indices, conteos de tablas y filas).
#
# Uso:
#   ./scripts/verificar-restore.sh
#   ./scripts/verificar-restore.sh sentrycore_verificacion_restore
# ---------------------------------------------------------------------------
set -eu

COMPOSE_FILE="docker-compose.dokploy.yml"
BASE_PRUEBA="${1:-sentrycore_verificacion_restore}"

if [ ! -f "$COMPOSE_FILE" ]; then
  if [ -f "docker-compose.production.yml" ]; then
    COMPOSE_FILE="docker-compose.production.yml"
  elif [ -f "docker-compose.yml" ]; then
    COMPOSE_FILE="docker-compose.yml"
  fi
fi

echo "== Ejecutando verificacion de restore en $BASE_PRUEBA con $COMPOSE_FILE =="
docker compose -f "$COMPOSE_FILE" exec -e ORIGEN_EN_VIVO=si postgres-backup \
  sh /scripts/verificar-restore.sh "$BASE_PRUEBA"
