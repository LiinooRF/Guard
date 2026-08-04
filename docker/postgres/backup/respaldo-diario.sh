#!/bin/sh
# ---------------------------------------------------------------------------
# Servicio de respaldo diario de VoxIA Control (issue #24).
#
# Es el `command` del servicio `postgres-backup` de docker-compose.dokploy.yml.
# Aca solo esta el RELOJ: el respaldo de verdad es respaldar-una-vez.sh, y se
# llama a ese, no a una copia. Asi el respaldo automatico, el que se corre a
# mano y el que prueba la CI son literalmente el mismo codigo.
#
# Entorno propio (el resto lo lee respaldar-una-vez.sh):
#   TZ                   zona horaria del reloj. En el compose: America/Santiago.
#   BACKUP_HORA          default 04:00
#   BACKUP_AL_ARRANCAR   default si. Si al arrancar todavia no existe el dump
#                        del dia, respalda de inmediato en vez de esperar a
#                        mañana. Sin esto, un redeploy a las 04:05 se come el
#                        respaldo del dia entero y nadie se entera.
# ---------------------------------------------------------------------------
set -u

ETIQUETA_LOG=respaldo-diario
. "$(dirname "$0")/comun.sh"

HORA="${BACKUP_HORA:-04:00}"
AL_ARRANCAR="${BACKUP_AL_ARRANCAR:-si}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
RESPALDAR="$(dirname "$0")/respaldar-una-vez.sh"

# El patron esta cerrado a 00:00-23:59 a proposito. Con `[0-2][0-9]:[0-5][0-9]`
# pasaban horas que no existen (24:00 a 29:59), y ahi el servicio arranca, hace
# el respaldo de arranque y despues `date -d "<fecha> 25:00"` falla para
# siempre: el loop queda durmiendo una hora, logueando el mismo error y sin
# volver a respaldar nunca. Un respaldo que no corre mas por un typo en el .env
# tiene que morir en la primera linea, no dentro del while.
case "$HORA" in
  [01][0-9]:[0-5][0-9] | 2[0-3]:[0-5][0-9]) : ;;
  *)
    registrar_error "BACKUP_HORA invalida: '$HORA' (formato HH:MM, de 00:00 a 23:59)"
    exit 1
    ;;
esac

if [ ! -f "$RESPALDAR" ]; then
  registrar_error "no se encuentra respaldar-una-vez.sh junto a este script ($RESPALDAR)"
  exit 1
fi

registrar "servicio arriba: respaldo diario a las $HORA (TZ=${TZ:-sin definir}), retencion ${BACKUP_RETENTION_DAYS:-30} dias"
if [ -z "${BACKUP_REMOTE:-}" ] && [ -z "${BACKUP_REMOTE_POSTGRES:-}" ]; then
  registrar_error "BACKUP_REMOTE esta vacio: los dumps quedaran SOLO en el disco del VPS"
fi

# `sh "$RESPALDAR"` y no `exec`: el loop tiene que seguir vivo aunque un
# respaldo falle. Un servicio de respaldo que se muere en la primera noche mala
# es peor que uno que reintenta y deja el error escrito.
#
# El codigo se captura con `|| CODIGO=$?` y NO leyendo $? despues de un `if`:
# cuando un `if` no ejecuta ninguna rama, su propio estado es 0 y el codigo real
# del comando se pierde.
respaldar() {
  CODIGO=0
  sh "$RESPALDAR" || CODIGO=$?
  if [ "$CODIGO" -eq 0 ]; then
    return 0
  fi
  if [ "$CODIGO" -eq 2 ]; then
    registrar_error "el respaldo quedo PARCIAL (sin copia confirmada fuera del VPS)"
  else
    registrar_error "el respaldo fallo (codigo $CODIGO); se reintenta a las $HORA de mañana"
  fi
  return "$CODIGO"
}

if [ "$AL_ARRANCAR" = "si" ] && [ ! -f "$BACKUP_DIR/voxia-$(date +%F).dump" ]; then
  registrar "todavia no hay dump de hoy: se respalda ahora sin esperar a las $HORA"
  respaldar || true
fi

while true; do
  OBJETIVO=$(proximo_objetivo "$HORA") || {
    registrar_error "no se pudo calcular la proxima corrida; se reintenta en 1 hora"
    sleep 3600
    continue
  }
  ESPERA=$((OBJETIVO - $(date +%s)))
  [ "$ESPERA" -lt 0 ] && ESPERA=0
  registrar "proximo respaldo: $(date -d "@$OBJETIVO" '+%F %T' 2> /dev/null || echo "$HORA") (en $ESPERA segundos)"
  sleep "$ESPERA"
  respaldar || true
done
