# Imagen del servicio de respaldos de VoxIA Control (issue #24).
#
# Es postgres:17-alpine mas rclone. La version de postgres NO se cambia por
# capricho: pg_dump se niega a respaldar un servidor mas nuevo que el cliente,
# asi que esta imagen tiene que ir a la par del servicio `postgres` del compose.
# Si algun dia se sube a postgres 18, se suben las dos juntas.
FROM postgres:17-alpine

# rclone es lo que saca el dump y las fotos FUERA del VPS.
#
# Va instalado en la imagen y no con un `apk add` al arrancar: un contenedor que
# necesita internet para poder respaldar deja de respaldar justo el dia que la
# red del VPS anda mal, que es cuando mas falta hace.
#
# tzdata se pide explicito aunque la imagen base suele traerlo: sin el,
# TZ=America/Santiago no tiene efecto y el respaldo de las "04:00" correria a
# las 04:00 UTC, o sea a medianoche en Chile y en pleno turno de ronda.
#
# La version de rclone es la que empaqueta Alpine; no esta clavada. Para fijarla
# —build reproducible— se reemplaza el RUN por el binario estatico oficial:
#   COPY --from=rclone/rclone:<version> /usr/local/bin/rclone /usr/local/bin/rclone
RUN apk add --no-cache rclone tzdata

# Comprobacion de que la imagen quedo con lo que tiene que tener. Falla el build
# aca antes que el respaldo a las cuatro de la mañana.
RUN pg_dump --version && pg_restore --version && rclone version

# Los scripts llegan por el montaje ./docker/postgres/backup:/scripts:ro del
# compose, no copiados a la imagen: asi un arreglo en el procedimiento de
# restore no obliga a reconstruir ni a redesplegar la imagen.
CMD ["sh", "/scripts/respaldo-diario.sh"]
