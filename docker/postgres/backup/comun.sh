#!/bin/sh
# ---------------------------------------------------------------------------
# Funciones compartidas por los scripts de respaldo de SentryCore (#24).
#
# NO se ejecuta solo: se incluye con `. "$(dirname "$0")/comun.sh"`.
#
# Todo lo de aca es POSIX sh puro y sin extensiones de GNU: el contenedor de
# respaldos es postgres:17-alpine, o sea busybox ash. Lo unico que se le pide a
# `date` es `date -d "AAAA-MM-DD HH:MM" +%s`, que es la unica forma que ya venia
# usandose en produccion y por lo tanto la unica probada en esa imagen.
# ---------------------------------------------------------------------------

# Etiqueta que precede a cada linea de log. Cada script pone la suya.
ETIQUETA_LOG="${ETIQUETA_LOG:-respaldo}"

registrar() {
  printf '[%s] [%s] %s\n' "$(date '+%F %T')" "$ETIQUETA_LOG" "$*"
}

registrar_error() {
  printf '[%s] [%s] ERROR: %s\n' "$(date '+%F %T')" "$ETIQUETA_LOG" "$*" >&2
}

registrar_aviso() {
  printf '[%s] [%s] AVISO: %s\n' "$(date '+%F %T')" "$ETIQUETA_LOG" "$*" >&2
}

# ---------------------------------------------------------------------------
# Secretos: regla 5 del proyecto. Un destino rclone puede venir como cadena de
# conexion en linea (`:s3,access_key_id=...,secret_access_key=...:bucket/ruta`),
# y eso es una credencial. Nunca se imprime crudo: ni en el log del servicio, ni
# en el resumen de un job, ni en un mensaje de error.
#
# La forma recomendada es la otra: el destino es `nombre:bucket/ruta` y las
# credenciales viajan en variables RCLONE_CONFIG_NOMBRE_* del gestor de secretos
# de Dokploy. Ahi no hay nada que redactar.
# ---------------------------------------------------------------------------
redactar_remoto() {
  case "$1" in
    :*)
      R_TIPO=${1#:}
      R_TIPO=${R_TIPO%%,*}
      R_TIPO=${R_TIPO%%:*}
      R_RUTA=${1##*:}
      printf ':%s,(parametros ocultos):%s\n' "$R_TIPO" "$R_RUTA"
      ;;
    *)
      printf '%s\n' "$1"
      ;;
  esac
}

exigir_binarios() {
  E_FALTA=0
  for E_BINARIO in "$@"; do
    if ! command -v "$E_BINARIO" > /dev/null 2>&1; then
      registrar_error "falta el binario '$E_BINARIO' en el contenedor"
      E_FALTA=1
    fi
  done
  [ "$E_FALTA" -eq 0 ]
}

# rclone con banderas fijas. --stats 0 apaga el reporte periodico (ruido en el
# log de un servicio que corre siempre) y NOTICE no imprime credenciales; -vv si
# lo haria, asi que no se usa.
ejecutar_rclone() {
  rclone --log-level NOTICE --stats 0 --retries 3 "$@"
}

# Tamaño en bytes de UN archivo dentro de un destino rclone, o vacio si no esta.
# El `/` del --include ancla el patron a la raiz del destino listado: sin el,
# `sentrycore-2026-08-03.dump` tambien haria match en subcarpetas.
tamano_remoto() {
  ejecutar_rclone lsl "$1" --include "/$2" 2> /dev/null | awk 'NR == 1 { print $1 }'
}

# ---------------------------------------------------------------------------
# Aritmetica de fechas de CALENDARIO, no de segundos.
#
# TRAMPA que este proyecto ya conoce: sumar 86400 segundos a un timestamp NO es
# sumar un dia. Chile mueve el reloj en septiembre y en abril; en esos dos dias
# del año "epoch + 86400" cae a las 03:00 o a las 05:00 locales, no a las 04:00.
# Por eso el dia se suma a la FECHA SIN ZONA y recien despues se convierte a
# epoch con la zona horaria del contenedor.
# ---------------------------------------------------------------------------

validar_fecha() {
  case "$1" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]) return 0 ;;
    *)
      registrar_error "fecha invalida (se espera AAAA-MM-DD): '$1'"
      return 1
      ;;
  esac
}

dias_del_mes() {
  D_ANIO=$1
  D_MES=$2
  case "$D_MES" in
    1 | 3 | 5 | 7 | 8 | 10 | 12) printf '31\n' ;;
    4 | 6 | 9 | 11) printf '30\n' ;;
    2)
      if [ $((D_ANIO % 4)) -eq 0 ] && { [ $((D_ANIO % 100)) -ne 0 ] || [ $((D_ANIO % 400)) -eq 0 ]; }; then
        printf '29\n'
      else
        printf '28\n'
      fi
      ;;
    *)
      registrar_error "mes invalido: '$D_MES'"
      return 1
      ;;
  esac
}

# Parte AAAA-MM-DD en F_ANIO/F_MES/F_DIA como enteros. El `#0` saca el cero a la
# izquierda: en aritmetica de shell "08" y "09" no son octal valido y revientan.
partir_fecha() {
  validar_fecha "$1" || return 1
  F_ANIO=${1%%-*}
  F_RESTO=${1#*-}
  F_MES=${F_RESTO%%-*}
  F_DIA=${F_RESTO#*-}
  F_MES=$((${F_MES#0} + 0))
  F_DIA=$((${F_DIA#0} + 0))
  F_ANIO=$((F_ANIO + 0))
  if [ "$F_MES" -lt 1 ] || [ "$F_MES" -gt 12 ] || [ "$F_DIA" -lt 1 ]; then
    registrar_error "fecha invalida: '$1'"
    return 1
  fi
}

# Valida una fecha de CALENDARIO, no solo su forma. `validar_fecha` comprueba
# que sean cuatro digitos-dos-dos y nada mas: '2026-02-30' y '2026-13-05' pasan
# ese filtro y no existen. Una fecha tipeada mal por el operador no puede
# terminar en "NO existe el respaldo del <fecha> fuera del VPS", que es una
# falsa alarma de perdida de respaldos.
#
# Deja F_ANIO/F_MES/F_DIA y F_ULTIMO (dias de ESE mes) listos para quien llame.
validar_fecha_real() {
  partir_fecha "$1" || return 1
  F_ULTIMO=$(dias_del_mes "$F_ANIO" "$F_MES") || return 1
  if [ "$F_DIA" -gt "$F_ULTIMO" ]; then
    registrar_error "fecha invalida: '$1' (el mes $F_MES tiene $F_ULTIMO dias)"
    return 1
  fi
}

sumar_un_dia() {
  validar_fecha_real "$1" || return 1
  F_DIA=$((F_DIA + 1))
  if [ "$F_DIA" -gt "$F_ULTIMO" ]; then
    F_DIA=1
    F_MES=$((F_MES + 1))
    if [ "$F_MES" -gt 12 ]; then
      F_MES=1
      F_ANIO=$((F_ANIO + 1))
    fi
  fi
  printf '%04d-%02d-%02d\n' "$F_ANIO" "$F_MES" "$F_DIA"
}

restar_un_dia() {
  # La misma validacion de calendario que sumar_un_dia: sin ella
  # `restar_un_dia 2026-02-30` devolvia '2026-02-29' en vez de fallar.
  validar_fecha_real "$1" || return 1
  F_DIA=$((F_DIA - 1))
  if [ "$F_DIA" -lt 1 ]; then
    F_MES=$((F_MES - 1))
    if [ "$F_MES" -lt 1 ]; then
      F_MES=12
      F_ANIO=$((F_ANIO - 1))
    fi
    F_DIA=$(dias_del_mes "$F_ANIO" "$F_MES") || return 1
  fi
  printf '%04d-%02d-%02d\n' "$F_ANIO" "$F_MES" "$F_DIA"
}

# Epoch del proximo HH:MM en la zona horaria del contenedor (TZ).
proximo_objetivo() {
  O_HORA=$1
  O_AHORA=$(date +%s)
  O_FECHA=$(date +%F)
  O_OBJETIVO=$(date -d "$O_FECHA $O_HORA" +%s) || return 1
  if [ "$O_OBJETIVO" -le "$O_AHORA" ]; then
    O_FECHA=$(sumar_un_dia "$O_FECHA") || return 1
    O_OBJETIVO=$(date -d "$O_FECHA $O_HORA" +%s) || return 1
  fi
  printf '%s\n' "$O_OBJETIVO"
}

# ---------------------------------------------------------------------------
# Cifrado de respaldos e integridad (issue #24 / #224).
#
# Soporta age, openssl y gpg. Las claves viajan por variables de entorno y
# nunca se imprimen ni se escriben en logs (regla 5).
# ---------------------------------------------------------------------------

detectar_herramienta_cifrado() {
  D_HERRAMIENTA="${BACKUP_ENCRYPTION_TOOL:-auto}"
  case "$D_HERRAMIENTA" in
    age | openssl | gpg | none)
      printf '%s\n' "$D_HERRAMIENTA"
      return 0
      ;;
    auto)
      if [ -n "${BACKUP_AGE_RECIPIENT:-}" ] || [ -n "${BACKUP_AGE_RECIPIENTS_FILE:-}" ] || [ -n "${BACKUP_AGE_IDENTITY:-}" ] || [ -n "${BACKUP_AGE_IDENTITY_FILE:-}" ]; then
        printf 'age\n'
      elif [ -n "${BACKUP_GPG_RECIPIENT:-}" ] || [ -n "${BACKUP_GPG_PASSPHRASE:-}" ]; then
        printf 'gpg\n'
      elif [ -n "${BACKUP_OPENSSL_PASSPHRASE:-}" ] || [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ] || [ -n "${BACKUP_ENCRYPTION_KEY:-}" ]; then
        printf 'openssl\n'
      else
        printf 'none\n'
      fi
      ;;
    *)
      registrar_error "herramienta de cifrado desconocida: '$D_HERRAMIENTA' (usar age, openssl, gpg o none)"
      return 1
      ;;
  esac
}

extension_cifrado() {
  case "$1" in
    age) printf '.age\n' ;;
    openssl) printf '.enc\n' ;;
    gpg) printf '.gpg\n' ;;
    *) printf '\n' ;;
  esac
}

detectar_herramienta_por_archivo() {
  case "$1" in
    *.age) printf 'age\n' ;;
    *.enc) printf 'openssl\n' ;;
    *.gpg) printf 'gpg\n' ;;
    *) printf 'none\n' ;;
  esac
}

cifrar_archivo() {
  C_ORIGEN="$1"
  C_DESTINO="$2"
  C_HERRAMIENTA="${3:-$(detectar_herramienta_cifrado)}"

  case "$C_HERRAMIENTA" in
    none)
      if [ "$C_ORIGEN" != "$C_DESTINO" ]; then
        cp -f "$C_ORIGEN" "$C_DESTINO"
      fi
      return 0
      ;;
    age)
      exigir_binarios age || return 1
      if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
        age -r "$BACKUP_AGE_RECIPIENT" -o "$C_DESTINO" "$C_ORIGEN"
      elif [ -n "${BACKUP_AGE_RECIPIENTS_FILE:-}" ]; then
        age -R "$BACKUP_AGE_RECIPIENTS_FILE" -o "$C_DESTINO" "$C_ORIGEN"
      elif [ -n "${BACKUP_AGE_IDENTITY_FILE:-}" ]; then
        if command -v age-keygen > /dev/null 2>&1; then
          AGE_PUB=$(age-keygen -y "$BACKUP_AGE_IDENTITY_FILE" 2> /dev/null) || true
          if [ -n "$AGE_PUB" ]; then
            age -r "$AGE_PUB" -o "$C_DESTINO" "$C_ORIGEN"
            return $?
          fi
        fi
        registrar_error "age requiere BACKUP_AGE_RECIPIENT o BACKUP_AGE_RECIPIENTS_FILE para cifrar"
        return 1
      elif [ -n "${BACKUP_AGE_IDENTITY:-}" ]; then
        TMP_ID=$(mktemp)
        chmod 600 "$TMP_ID"
        printf '%s\n' "$BACKUP_AGE_IDENTITY" > "$TMP_ID"
        if command -v age-keygen > /dev/null 2>&1; then
          AGE_PUB=$(age-keygen -y "$TMP_ID" 2> /dev/null) || true
          rm -f "$TMP_ID"
          if [ -n "$AGE_PUB" ]; then
            age -r "$AGE_PUB" -o "$C_DESTINO" "$C_ORIGEN"
            return $?
          fi
        else
          rm -f "$TMP_ID"
        fi
        registrar_error "age requiere BACKUP_AGE_RECIPIENT o BACKUP_AGE_RECIPIENTS_FILE para cifrar"
        return 1
      else
        registrar_error "para cifrar con age configure BACKUP_AGE_RECIPIENT o BACKUP_AGE_RECIPIENTS_FILE"
        return 1
      fi
      ;;
    openssl)
      exigir_binarios openssl || return 1
      CLAVE="${BACKUP_OPENSSL_PASSPHRASE:-${BACKUP_ENCRYPTION_PASSPHRASE:-${BACKUP_ENCRYPTION_KEY:-}}}"
      if [ -z "$CLAVE" ]; then
        registrar_error "para cifrar con openssl configure BACKUP_OPENSSL_PASSPHRASE o BACKUP_ENCRYPTION_PASSPHRASE"
        return 1
      fi
      openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -salt -in "$C_ORIGEN" -out "$C_DESTINO" -pass "pass:$CLAVE"
      ;;
    gpg)
      exigir_binarios gpg || return 1
      if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
        gpg --batch --yes --trust-model always --encrypt --recipient "$BACKUP_GPG_RECIPIENT" -o "$C_DESTINO" "$C_ORIGEN"
      else
        CLAVE="${BACKUP_GPG_PASSPHRASE:-${BACKUP_ENCRYPTION_PASSPHRASE:-${BACKUP_ENCRYPTION_KEY:-}}}"
        if [ -z "$CLAVE" ]; then
          registrar_error "para cifrar con gpg configure BACKUP_GPG_RECIPIENT o BACKUP_GPG_PASSPHRASE"
          return 1
        fi
        gpg --batch --yes --pinentry-mode loopback --passphrase "$CLAVE" --symmetric --cipher-algo AES256 -o "$C_DESTINO" "$C_ORIGEN"
      fi
      ;;
    *)
      registrar_error "herramienta de cifrado no soportada: '$C_HERRAMIENTA'"
      return 1
      ;;
  esac
}

descifrar_archivo() {
  D_ORIGEN="$1"
  D_DESTINO="$2"
  D_HERRAMIENTA="${3:-$(detectar_herramienta_por_archivo "$D_ORIGEN")}"

  if [ "$D_HERRAMIENTA" = "none" ] || [ "$D_HERRAMIENTA" = "auto" ]; then
    D_HERRAMIENTA=$(detectar_herramienta_cifrado)
  fi

  case "$D_HERRAMIENTA" in
    none)
      if [ "$D_ORIGEN" != "$D_DESTINO" ]; then
        cp -f "$D_ORIGEN" "$D_DESTINO"
      fi
      return 0
      ;;
    age)
      exigir_binarios age || return 1
      if [ -n "${BACKUP_AGE_IDENTITY_FILE:-}" ] && [ -f "$BACKUP_AGE_IDENTITY_FILE" ]; then
        age -d -i "$BACKUP_AGE_IDENTITY_FILE" -o "$D_DESTINO" "$D_ORIGEN"
      elif [ -n "${BACKUP_AGE_IDENTITY:-}" ]; then
        TMP_ID=$(mktemp)
        chmod 600 "$TMP_ID"
        printf '%s\n' "$BACKUP_AGE_IDENTITY" > "$TMP_ID"
        age -d -i "$TMP_ID" -o "$D_DESTINO" "$D_ORIGEN"
        R_AGE=$?
        rm -f "$TMP_ID"
        return "$R_AGE"
      else
        registrar_error "para descifrar con age configure BACKUP_AGE_IDENTITY_FILE o BACKUP_AGE_IDENTITY"
        return 1
      fi
      ;;
    openssl)
      exigir_binarios openssl || return 1
      CLAVE="${BACKUP_OPENSSL_PASSPHRASE:-${BACKUP_ENCRYPTION_PASSPHRASE:-${BACKUP_ENCRYPTION_KEY:-}}}"
      if [ -z "$CLAVE" ]; then
        registrar_error "para descifrar con openssl configure BACKUP_OPENSSL_PASSPHRASE o BACKUP_ENCRYPTION_PASSPHRASE"
        return 1
      fi
      openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in "$D_ORIGEN" -out "$D_DESTINO" -pass "pass:$CLAVE"
      ;;
    gpg)
      exigir_binarios gpg || return 1
      CLAVE="${BACKUP_GPG_PASSPHRASE:-${BACKUP_ENCRYPTION_PASSPHRASE:-${BACKUP_ENCRYPTION_KEY:-}}}"
      if [ -n "$CLAVE" ]; then
        gpg --batch --yes --pinentry-mode loopback --passphrase "$CLAVE" --decrypt -o "$D_DESTINO" "$D_ORIGEN"
      else
        gpg --batch --yes --decrypt -o "$D_DESTINO" "$D_ORIGEN"
      fi
      ;;
    *)
      registrar_error "herramienta de descifrado no soportada: '$D_HERRAMIENTA'"
      return 1
      ;;
  esac
}

generar_checksum() {
  G_ARCH="$1"
  if [ ! -f "$G_ARCH" ]; then
    registrar_error "archivo no encontrado para generar checksum: $G_ARCH"
    return 1
  fi
  G_DIR=$(dirname "$G_ARCH")
  G_BASE=$(basename "$G_ARCH")
  ( cd "$G_DIR" && sha256sum "$G_BASE" > "$G_BASE.sha256" )
}

verificar_checksum() {
  V_ARCH="$1"
  V_DIR=$(dirname "$V_ARCH")
  V_BASE=$(basename "$V_ARCH")
  V_CHECKSUM="$V_ARCH.sha256"

  if [ ! -f "$V_CHECKSUM" ]; then
    registrar_aviso "no existe archivo de checksum: $V_CHECKSUM (se omite verificacion sha256)"
    return 0
  fi

  if ( cd "$V_DIR" && sha256sum -c "$V_BASE.sha256" > /dev/null 2>&1 ); then
    registrar "integridad verificada con exito (sha256): $V_BASE"
    return 0
  else
    registrar_error "FALLA DE INTEGRIDAD: el checksum sha256 de $V_BASE no coincide"
    return 1
  fi
}
