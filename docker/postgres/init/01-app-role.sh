#!/bin/bash
# ---------------------------------------------------------------------------
# Rol de aplicacion de VoxIA Control.
#
# El producto es multi-tenant: muchas empresas comparten una sola base y el
# aislamiento se aplica con Row Level Security. Para que RLS sirva de algo, la
# aplicacion NO puede conectarse como superusuario ni con BYPASSRLS: si lo
# hiciera, PostgreSQL ignoraria todas las politicas y un WHERE olvidado
# filtraria datos de una empresa a otra.
#
# Este script crea ese rol restringido. Corre una sola vez, cuando el volumen
# de datos esta vacio. Para re-ejecutarlo: docker compose down -v
#
# Ver issue #7 (Modelo de datos multi-tenant con RLS).
# ---------------------------------------------------------------------------
set -euo pipefail

APP_USER="${DATABASE_APP_USER:-voxia_app}"
APP_PASSWORD="${DATABASE_APP_PASSWORD:-cambiar_en_local}"

echo "[voxia] creando rol de aplicacion '${APP_USER}' (sin BYPASSRLS)"

psql -v ON_ERROR_STOP=1 \
     --username "$POSTGRES_USER" \
     --dbname "$POSTGRES_DB" \
     -v app_user="$APP_USER" \
     -v app_password="$APP_PASSWORD" <<-'EOSQL'
	SELECT format(
	  'CREATE ROLE %I LOGIN PASSWORD %L NOBYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE',
	  :'app_user', :'app_password'
	)
	WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
	\gexec

	GRANT USAGE, CREATE ON SCHEMA public TO :"app_user";

	-- Todo objeto creado despues hereda estos permisos, para no depender de que
	-- alguien recuerde un GRANT en cada migracion.
	ALTER DEFAULT PRIVILEGES IN SCHEMA public
	  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"app_user";
	ALTER DEFAULT PRIVILEGES IN SCHEMA public
	  GRANT USAGE, SELECT ON SEQUENCES TO :"app_user";
EOSQL

# Verificacion explicita: si el rol tuviera BYPASSRLS, el aislamiento entre
# empresas seria una ilusion. Preferimos fallar el arranque a arrancar mal.
BYPASS=$(psql -tAX --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -c "SELECT rolbypassrls FROM pg_roles WHERE rolname = '${APP_USER}'")

if [ "$BYPASS" != "f" ]; then
  echo "[voxia] ERROR: el rol ${APP_USER} tiene BYPASSRLS. RLS no protegeria nada." >&2
  exit 1
fi

echo "[voxia] rol '${APP_USER}' listo y sin BYPASSRLS"
