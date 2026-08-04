#!/bin/sh
# ---------------------------------------------------------------------------
# Restore de la EVIDENCIA FOTOGRAFICA desde la copia de fuera del VPS (#24).
#
# La otra mitad del restore. `restore.sh` devuelve la base; sin este script, la
# base restaurada apunta a fotos que no existen: los informes salen con la ronda
# completa y la foto rota, que en un juicio laboral es peor que no tener nada.
#
# Uso:
#   docker compose -f docker-compose.dokploy.yml exec postgres-backup \
#     sh /scripts/restaurar-evidencia.sh /evidencia-restore
#
#   # desastre real, sobre el volumen que usa la API:
#   docker compose -f docker-compose.dokploy.yml exec \
#     -e CONFIRMO_RESTORE_PRODUCTIVO=si postgres-backup \
#     sh /scripts/restaurar-evidencia.sh /evidencia
#
# OJO con el montaje: en el compose, /evidencia va de SOLO LECTURA a proposito
# (el respaldo no tiene por que poder escribir en la evidencia). Para restaurar
# encima hay que montar el volumen con escritura; esta en docs/respaldos.md.
#
# Copia con `copy`, nunca `sync`: no borra lo que ya haya en el destino. Un
# restore que empieza borrando es un segundo desastre encima del primero.
#
# Entorno:
#   BACKUP_REMOTE / BACKUP_REMOTE_EVIDENCIA   destino rclone de las fotos
#   EVIDENCE_DIR                              default /evidencia (el vivo)
#   CONFIRMO_RESTORE_PRODUCTIVO=si            permite escribir en el vivo
#
# Salida: 0 si todas las fotos del respaldo quedaron en el destino y coinciden.
# ---------------------------------------------------------------------------
set -eu

ETIQUETA_LOG=restaurar-evidencia
. "$(dirname "$0")/comun.sh"

DESTINO="${1:-}"
EVIDENCE_DIR="${EVIDENCE_DIR:-/evidencia}"
REMOTO_BASE="${BACKUP_REMOTE:-}"
REMOTO_BASE="${REMOTO_BASE%/}"
REMOTO_EV="${BACKUP_REMOTE_EVIDENCIA:-${REMOTO_BASE:+$REMOTO_BASE/evidencia}}"

if [ -z "$DESTINO" ]; then
  echo "uso: restaurar-evidencia.sh <directorio-destino>" >&2
  echo "ej.: restaurar-evidencia.sh /evidencia-restore" >&2
  exit 1
fi

if [ -z "$REMOTO_EV" ]; then
  registrar_error "BACKUP_REMOTE no esta configurado: no hay de donde restaurar las fotos"
  exit 1
fi

exigir_binarios rclone || exit 1

if [ "$DESTINO" = "$EVIDENCE_DIR" ] && [ "${CONFIRMO_RESTORE_PRODUCTIVO:-no}" != "si" ]; then
  registrar_error "'$DESTINO' es la evidencia en uso. Solo para un desastre real:"
  registrar_error "  CONFIRMO_RESTORE_PRODUCTIVO=si sh /scripts/restaurar-evidencia.sh $DESTINO"
  exit 1
fi

mkdir -p "$DESTINO"
if [ ! -w "$DESTINO" ]; then
  registrar_error "no se puede escribir en '$DESTINO' (¿el volumen esta montado :ro?)"
  exit 1
fi

INICIO=$(date +%s)
registrar "restaurando la evidencia desde $(redactar_remoto "$REMOTO_EV") hacia $DESTINO"

if ! ejecutar_rclone copy "$REMOTO_EV" "$DESTINO"; then
  registrar_error "rclone no pudo traer la evidencia"
  exit 1
fi

SEGUNDOS=$(($(date +%s) - INICIO))

# Que rclone termine en 0 no dice que todo llego intacto. --one-way con el
# REMOTO como origen exige que cada archivo del respaldo este en el destino con
# el mismo hash, e ignora lo que el destino tenga de mas.
registrar "comparando el destino contra el respaldo"
if ! ejecutar_rclone check "$REMOTO_EV" "$DESTINO" --one-way; then
  registrar_error "faltan fotos en el destino o su contenido no coincide con el respaldo"
  exit 1
fi

ARCHIVOS=$(find "$DESTINO" -type f | wc -l | tr -d ' ')
registrar "== RESTORE DE EVIDENCIA OK: $ARCHIVOS archivos en ${SEGUNDOS}s =="
registrar "recordar que la API lee esta ruta desde EVIDENCE_PATH; ver docs/respaldos.md"
