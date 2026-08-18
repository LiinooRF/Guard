#!/bin/sh
# ---------------------------------------------------------------------------
# ¿Existe el respaldo de AYER fuera del VPS? (criterio del issue #24)
#
# Es la comprobacion que contesta la pregunta que importa a las 3 de la mañana:
# no "¿corrio el servicio?" sino "¿hay un archivo restaurable en otro lado?".
# Mira el destino remoto, no el log ni el disco local.
#
# Uso:
#   docker compose -f docker-compose.dokploy.yml exec postgres-backup \
#     sh /scripts/verificar-copia-remota.sh              # ayer
#   ... sh /scripts/verificar-copia-remota.sh 2026-08-01 # una fecha concreta
#
# Por defecto pregunta por AYER a proposito: el dump de hoy se escribe a las
# 04:00, asi que "hoy" fallaria toda la madrugada por diseño y la alerta se
# volveria ruido que nadie mira.
#
# Entorno:
#   BACKUP_REMOTE / BACKUP_REMOTE_POSTGRES   destino rclone (igual que el respaldo)
#   BACKUP_DIR              default /backups
#   EVIDENCE_DIR            default /evidencia
#   VERIFICAR_EVIDENCIA     default no. Con 'si' compara ademas hash por hash
#                           todas las fotos contra el destino: es correcto pero
#                           lee el volumen entero, asi que no va en un chequeo
#                           que corre seguido.
#
# Salida: 0 si el respaldo de esa fecha esta fuera del VPS; 1 si no.
# ---------------------------------------------------------------------------
set -eu

ETIQUETA_LOG=verificar-copia
. "$(dirname "$0")/comun.sh"

BACKUP_DIR="${BACKUP_DIR:-/backups}"
EVIDENCE_DIR="${EVIDENCE_DIR:-/evidencia}"
REMOTO_BASE="${BACKUP_REMOTE:-}"
REMOTO_BASE="${REMOTO_BASE%/}"
REMOTO_PG="${BACKUP_REMOTE_POSTGRES:-${REMOTO_BASE:+$REMOTO_BASE/postgres}}"
REMOTO_EV="${BACKUP_REMOTE_EVIDENCIA:-${REMOTO_BASE:+$REMOTO_BASE/evidencia}}"

if [ "$#" -ge 1 ] && [ -n "$1" ]; then
  FECHA="$1"
  # Validacion de CALENDARIO, no solo de forma: '2026-02-31' tiene la forma
  # correcta, no existe, y sin este filtro el script terminaria en "NO existe
  # el respaldo del 2026-02-31 fuera del VPS" — una falsa alarma de perdida de
  # respaldos por un error de tipeo.
  validar_fecha_real "$FECHA" || exit 1
else
  FECHA=$(restar_un_dia "$(date +%F)") || exit 1
fi

ARCHIVO="sentrycore-$FECHA.dump"

if [ -z "$REMOTO_PG" ]; then
  registrar_error "BACKUP_REMOTE no esta configurado: NO hay ningun respaldo fuera del VPS."
  registrar_error "Hoy un incendio del VPS se lleva la base y los dumps juntos."
  exit 1
fi

exigir_binarios rclone || exit 1

registrar "buscando $ARCHIVO en $(redactar_remoto "$REMOTO_PG")"

BYTES_REMOTO=$(tamano_remoto "$REMOTO_PG" "$ARCHIVO")

if [ -z "$BYTES_REMOTO" ]; then
  registrar_error "NO existe el respaldo del $FECHA fuera del VPS."
  registrar_error "Revisar el log del servicio postgres-backup y $BACKUP_DIR/estado-respaldo.txt"
  exit 1
fi

if [ "$BYTES_REMOTO" -le 0 ]; then
  registrar_error "el respaldo del $FECHA existe en el destino pero pesa 0 bytes"
  exit 1
fi

registrar "OK: el respaldo del $FECHA esta fuera del VPS ($BYTES_REMOTO bytes)"

# Si el dump todavia esta en el disco local, los tamaños tienen que coincidir.
# Una subida cortada deja un objeto mas chico y por si solo parece un respaldo.
LOCAL="$BACKUP_DIR/$ARCHIVO"
if [ -f "$LOCAL" ]; then
  BYTES_LOCAL=$(wc -c < "$LOCAL" | tr -d ' ')
  if [ "$BYTES_LOCAL" != "$BYTES_REMOTO" ]; then
    registrar_error "el remoto no coincide con el local: local $BYTES_LOCAL bytes, remoto $BYTES_REMOTO bytes"
    exit 1
  fi
  registrar "coincide con la copia local ($BYTES_LOCAL bytes)"
else
  registrar "el dump del $FECHA ya no esta en el disco local; solo se comprueba el remoto"
fi

if [ "${VERIFICAR_EVIDENCIA:-no}" = "si" ]; then
  if [ -z "$REMOTO_EV" ] || [ ! -d "$EVIDENCE_DIR" ]; then
    registrar_error "no se puede verificar la evidencia: falta destino remoto o $EVIDENCE_DIR"
    exit 1
  fi
  registrar "comparando la evidencia fotografica contra $(redactar_remoto "$REMOTO_EV")"
  if ejecutar_rclone check "$EVIDENCE_DIR" "$REMOTO_EV/" --one-way; then
    registrar "OK: toda la evidencia local esta fuera del VPS"
  else
    registrar_error "hay fotos que no estan fuera del VPS o difieren del original"
    exit 1
  fi
fi

# Lo ultimo que se copio, para ver de un vistazo la retencion real del destino.
registrar "ultimos respaldos en el destino remoto:"
ejecutar_rclone lsl "$REMOTO_PG" --include '/sentrycore-*.dump' 2> /dev/null | sort -k2 | tail -5 || true
