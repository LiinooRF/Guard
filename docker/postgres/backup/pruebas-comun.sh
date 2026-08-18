#!/bin/sh
# ---------------------------------------------------------------------------
# Pruebas de comun.sh. Corren DENTRO de la imagen del servicio de respaldos
# (busybox ash + la base de zonas horarias), que es el unico lugar donde el
# resultado significa algo: en el portatil de quien las escribe no hay busybox
# ni tzdata, y las dos cosas son justamente lo que se esta probando.
#
#   docker run --rm -e TZ=America/Santiago -v "$PWD/docker/postgres/backup:/scripts:ro" \
#     sentrycore-backup:ci sh /scripts/pruebas-comun.sh
#
# Las corre .github/workflows/backup-restore.yml en cada PR que toque esta
# carpeta. Salida 0 si todo pasa.
# ---------------------------------------------------------------------------
set -eu

ETIQUETA_LOG=pruebas
. "$(dirname "$0")/comun.sh"

FALLAS=0

igual() {
  if [ "$2" = "$3" ]; then
    printf '  [ok]    %s = %s\n' "$1" "$2"
  else
    printf '  [FALLA] %s = %s (esperado %s)\n' "$1" "$2" "$3" >&2
    FALLAS=$((FALLAS + 1))
  fi
}

# Las tres puertas de entrada de una fecha, no solo sumar_un_dia: restar_un_dia
# la usa verificar-copia-remota.sh con la fecha que tipea el operador, y
# validar_fecha_real es la que ese script llama cuando la fecha viene por
# argumento. Una fecha que existe en la forma pero no en el calendario tiene que
# morir en las tres, o el resultado es una falsa alarma de respaldo perdido.
rechaza() {
  for FUNCION in sumar_un_dia restar_un_dia validar_fecha_real; do
    if "$FUNCION" "$1" > /dev/null 2>&1; then
      printf '  [FALLA] %s acepto una fecha invalida: "%s"\n' "$FUNCION" "$1" >&2
      FALLAS=$((FALLAS + 1))
    else
      printf '  [ok]    %s rechaza "%s"\n' "$FUNCION" "$1"
    fi
  done
}

echo "== 1. aritmetica de calendario =="
igual "2024-02-28 +1d" "$(sumar_un_dia 2024-02-28)" "2024-02-29"
igual "2024-02-29 +1d" "$(sumar_un_dia 2024-02-29)" "2024-03-01"
igual "2025-02-28 +1d" "$(sumar_un_dia 2025-02-28)" "2025-03-01"
igual "2000-02-28 +1d" "$(sumar_un_dia 2000-02-28)" "2000-02-29"
igual "1900-02-28 +1d" "$(sumar_un_dia 1900-02-28)" "1900-03-01"
igual "2026-08-31 +1d" "$(sumar_un_dia 2026-08-31)" "2026-09-01"
igual "2026-12-31 +1d" "$(sumar_un_dia 2026-12-31)" "2027-01-01"
igual "2026-03-01 -1d" "$(restar_un_dia 2026-03-01)" "2026-02-28"
igual "2024-03-01 -1d" "$(restar_un_dia 2024-03-01)" "2024-02-29"
igual "2026-01-01 -1d" "$(restar_un_dia 2026-01-01)" "2025-12-31"
igual "2026-09-01 -1d" "$(restar_un_dia 2026-09-01)" "2026-08-31"

echo "== 2. fechas invalidas =="
for MALA in "2026-13-01" "2026-02-30" "2026-02-31" "2026-04-31" "2026-1-1" "no-es-fecha" "" "2026-00-10" "2026-05-00"; do
  rechaza "$MALA"
done

echo "== 3. secretos fuera del log (regla 5) =="
igual "destino normal" "$(redactar_remoto 'r2:sentrycore-respaldos/postgres')" "r2:sentrycore-respaldos/postgres"
REDACTADO=$(redactar_remoto ':s3,access_key_id=AKIA_SECRETA,secret_access_key=CLAVE_SECRETA:balde/ruta')
igual "cadena de conexion" "$REDACTADO" ":s3,(parametros ocultos):balde/ruta"
case "$REDACTADO" in
  *AKIA_SECRETA* | *CLAVE_SECRETA*)
    printf '  [FALLA] la redaccion dejo pasar la credencial\n' >&2
    FALLAS=$((FALLAS + 1))
    ;;
  *) printf '  [ok]    no quedan credenciales en el texto redactado\n' ;;
esac

# ---------------------------------------------------------------------------
# 4. Zona horaria. Aca se prueba lo que no se puede probar fuera del contenedor:
# que la imagen TIENE la base de zonas horarias y que sumar un dia de calendario
# no es lo mismo que sumar 86400 segundos.
#
# No se clavan las fechas de los cambios de hora de Chile a proposito: las reglas
# ya cambiaron varias veces (2015, 2016, 2022) y una prueba con la fecha escrita
# a mano se cae sola cuando la imagen actualice tzdata. Se prueba la propiedad,
# no el calendario de este año.
# ---------------------------------------------------------------------------
echo "== 4. zona horaria del recinto y cambio de hora =="
ZONA=$(TZ=America/Santiago date -d "2026-01-15 12:00" +%Z 2> /dev/null || echo "")
if [ -z "$ZONA" ]; then
  printf '  [FALLA] `date -d "AAAA-MM-DD HH:MM"` no funciona en esta imagen\n' >&2
  FALLAS=$((FALLAS + 1))
elif [ "$ZONA" = "UTC" ] || [ "$ZONA" = "GMT" ]; then
  printf '  [FALLA] falta tzdata: TZ=America/Santiago cae en %s y el respaldo de las 04:00 correria a medianoche en Chile\n' "$ZONA" >&2
  FALLAS=$((FALLAS + 1))
else
  printf '  [ok]    la imagen resuelve America/Santiago (%s)\n' "$ZONA"

  # Un año entero de saltos de las 04:00 de un dia a las 04:00 del siguiente.
  #
  # Lo que se EXIGE es que cada salto dure 23, 24 o 25 horas exactas. Cualquier
  # otro valor significa que sumar_un_dia se salto un dia o repitio uno: 48h
  # seria un dia perdido, y un dia perdido es una noche sin respaldo.
  #
  # Cuantos cambios de hora tiene el año NO se exige: Chile ya cambio sus reglas
  # en 2015, 2016 y 2022, y una prueba que las de por sentadas se cae sola
  # cuando la imagen actualice tzdata. Se informa y ya.
  FECHA=2026-01-01
  RAROS=0
  DIAS=0
  MALOS=0
  EJEMPLO=""
  while [ "$DIAS" -lt 365 ]; do
    SIGUIENTE=$(sumar_un_dia "$FECHA")
    A=$(TZ=America/Santiago date -d "$FECHA 04:00" +%s)
    B=$(TZ=America/Santiago date -d "$SIGUIENTE 04:00" +%s)
    SALTO=$((B - A))
    case "$SALTO" in
      86400) : ;;
      82800 | 90000)
        RAROS=$((RAROS + 1))
        if [ -z "$EJEMPLO" ]; then
          EJEMPLO="$FECHA -> $SIGUIENTE duro ${SALTO}s"
        fi
        ;;
      *)
        MALOS=$((MALOS + 1))
        printf '  [FALLA] el salto %s -> %s duro %ss (no son 23, 24 ni 25 horas)\n' \
          "$FECHA" "$SIGUIENTE" "$SALTO" >&2
        ;;
    esac
    FECHA=$SIGUIENTE
    DIAS=$((DIAS + 1))
  done

  igual "el 2026 arranco y termino donde debia" "$FECHA" "2027-01-01"

  if [ "$MALOS" -eq 0 ]; then
    printf '  [ok]    los 365 saltos de 04:00 a 04:00 duran 23, 24 o 25 horas\n'
  else
    FALLAS=$((FALLAS + MALOS))
  fi

  if [ "$RAROS" -gt 0 ]; then
    printf '  [ok]    %s cambio(s) de hora en 2026 (%s): son los dias en que "epoch + 86400" habria corrido el respaldo de las 04:00\n' \
      "$RAROS" "$EJEMPLO"
  else
    printf '  [aviso] esta tzdata no tiene cambios de hora en 2026 para America/Santiago; la trampa no se pudo demostrar\n'
  fi
fi

# ---------------------------------------------------------------------------
# 5. Cifrado e integridad de respaldos (issue #24 / #224)
# ---------------------------------------------------------------------------
echo "== 5. cifrado e integridad (checksum sha256, openssl, age, gpg) =="
DIR_PRUEBA=$(mktemp -d)
trap 'rm -rf "$DIR_PRUEBA"' EXIT INT TERM

# 5.1 Checksum sha256
printf 'contenido de prueba para checksum\n' > "$DIR_PRUEBA/datos.txt"
if generar_checksum "$DIR_PRUEBA/datos.txt" && [ -f "$DIR_PRUEBA/datos.txt.sha256" ]; then
  printf '  [ok]    generar_checksum creo archivo .sha256\n'
else
  printf '  [FALLA] generar_checksum no creo el archivo .sha256\n' >&2
  FALLAS=$((FALLAS + 1))
fi

if verificar_checksum "$DIR_PRUEBA/datos.txt"; then
  printf '  [ok]    verificar_checksum valido archivo integro\n'
else
  printf '  [FALLA] verificar_checksum fallo en archivo valido\n' >&2
  FALLAS=$((FALLAS + 1))
fi

printf 'contenido adulterado\n' > "$DIR_PRUEBA/datos.txt"
if verificar_checksum "$DIR_PRUEBA/datos.txt" > /dev/null 2>&1; then
  printf '  [FALLA] verificar_checksum acepto archivo corrupto\n' >&2
  FALLAS=$((FALLAS + 1))
else
  printf '  [ok]    verificar_checksum rechazo archivo corrupto\n'
fi

# 5.2 OpenSSL aes-256-cbc
printf 'datos confidenciales para openssl\n' > "$DIR_PRUEBA/secreto-openssl.txt"
CLAVE_PRUEBA="ClaveSuperSecreta12345!"
BACKUP_OPENSSL_PASSPHRASE="$CLAVE_PRUEBA" cifrar_archivo "$DIR_PRUEBA/secreto-openssl.txt" "$DIR_PRUEBA/secreto-openssl.enc" "openssl"
BACKUP_OPENSSL_PASSPHRASE="$CLAVE_PRUEBA" descifrar_archivo "$DIR_PRUEBA/secreto-openssl.enc" "$DIR_PRUEBA/descifrado-openssl.txt" "openssl"
if diff -u "$DIR_PRUEBA/secreto-openssl.txt" "$DIR_PRUEBA/descifrado-openssl.txt" > /dev/null 2>&1; then
  printf '  [ok]    cifrado y descifrado openssl coinciden byte a byte\n'
else
  printf '  [FALLA] openssl no recupero el contenido original\n' >&2
  FALLAS=$((FALLAS + 1))
fi

# 5.3 age (asimetrico con age-keygen y recipient)
if command -v age-keygen > /dev/null 2>&1 && command -v age > /dev/null 2>&1; then
  printf 'datos confidenciales para age\n' > "$DIR_PRUEBA/secreto-age.txt"
  age-keygen -o "$DIR_PRUEBA/age.key" 2> /dev/null
  AGE_REC=$(age-keygen -y "$DIR_PRUEBA/age.key")
  BACKUP_AGE_RECIPIENT="$AGE_REC" cifrar_archivo "$DIR_PRUEBA/secreto-age.txt" "$DIR_PRUEBA/secreto-age.age" "age"
  BACKUP_AGE_IDENTITY_FILE="$DIR_PRUEBA/age.key" descifrar_archivo "$DIR_PRUEBA/secreto-age.age" "$DIR_PRUEBA/descifrado-age.txt" "age"
  if diff -u "$DIR_PRUEBA/secreto-age.txt" "$DIR_PRUEBA/descifrado-age.txt" > /dev/null 2>&1; then
    printf '  [ok]    cifrado y descifrado age coinciden byte a byte\n'
  else
    printf '  [FALLA] age no recupero el contenido original\n' >&2
    FALLAS=$((FALLAS + 1))
  fi
else
  printf '  [aviso] age o age-keygen no disponible para prueba\n'
fi

# 5.4 gpg (simetrico)
if command -v gpg > /dev/null 2>&1; then
  printf 'datos confidenciales para gpg\n' > "$DIR_PRUEBA/secreto-gpg.txt"
  BACKUP_GPG_PASSPHRASE="$CLAVE_PRUEBA" cifrar_archivo "$DIR_PRUEBA/secreto-gpg.txt" "$DIR_PRUEBA/secreto-gpg.gpg" "gpg"
  BACKUP_GPG_PASSPHRASE="$CLAVE_PRUEBA" descifrar_archivo "$DIR_PRUEBA/secreto-gpg.gpg" "$DIR_PRUEBA/descifrado-gpg.txt" "gpg"
  if diff -u "$DIR_PRUEBA/secreto-gpg.txt" "$DIR_PRUEBA/descifrado-gpg.txt" > /dev/null 2>&1; then
    printf '  [ok]    cifrado y descifrado gpg coinciden byte a byte\n'
  else
    printf '  [FALLA] gpg no recupero el contenido original\n' >&2
    FALLAS=$((FALLAS + 1))
  fi
else
  printf '  [aviso] gpg no disponible para prueba\n'
fi

echo ""
if [ "$FALLAS" -eq 0 ]; then
  echo "PRUEBAS OK"
  exit 0
fi
echo "PRUEBAS FALLIDAS: $FALLAS" >&2
exit 1
