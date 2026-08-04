#!/bin/sh
# ---------------------------------------------------------------------------
# Prueba de restore de VoxIA Control: dump -> restore -> VERIFICAR CONTENIDO.
# Issue #24: "un backup que nunca se restauro no es un backup".
#
# Que hace, en orden:
#   1. Toma un pg_dump -Fc con EL MISMO comando del servicio postgres-backup de
#      docker-compose.dokploy.yml (escribe a *.part y renombra al terminar).
#   2. Restaura ese dump en una base VACIA y DISTINTA llamando a restore.sh
#      —el mismo script del procedimiento manual—, no a un pg_restore propio:
#      si restore.sh cambia, esta prueba prueba el cambio.
#   3. Verifica que el restore SIRVE, no solo que no dio error:
#        - misma cantidad de tablas, y mayor que cero
#        - toda tabla con tenant_id conserva RLS ENABLE y FORCE en el destino
#          (un restore que pierde las politicas es una fuga esperando)
#        - mismas politicas RLS, con el mismo USING y WITH CHECK
#        - app_tenant_id() y app_has_audited_support_access() existen Y CORREN,
#          y la segunda falla cerrada sin contexto
#        - mismos GRANT para el rol de la aplicacion
#        - mismos indices
#        - mismos conteos de filas por tabla entre origen y destino
#   4. Mide y reporta el tiempo de restore.
#
# Por que no alcanza con el codigo de salida de pg_restore: pg_restore puede
# terminar habiendo ignorado errores. Por eso la verificacion es de contenido.
#
# Uso en el VPS (el compose ya monta esta carpeta en /scripts):
#
#   docker compose -f docker-compose.dokploy.yml exec postgres-backup \
#     sh /scripts/verificar-restore.sh voxia_verificacion_restore
#
# Uso en CI: .github/workflows/backup-restore.yml lo corre dentro de una imagen
# postgres:17-alpine —la misma del servicio de backup— contra el Postgres del job.
#
# Entorno que espera:
#   PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE  del DUEÑO de la base, los mismos
#     que usa postgres-backup. voxia_app no sirve: no puede crear bases y RLS le
#     cierra la lectura sin contexto de tenant, asi que el dump saldria vacio.
#   DATABASE_APP_USER   rol de la aplicacion cuyos GRANT se comparan (voxia_app).
#   CONSERVAR=si        no borra la base de prueba ni el dump al terminar.
#   ORIGEN_EN_VIVO=si   el origen recibe escrituras durante la prueba (VPS real):
#                       una diferencia de FILAS pasa a ser aviso en vez de falla.
#                       El esquema, RLS y politicas se siguen exigiendo iguales.
#   RESUMEN_ARCHIVO     ruta donde ademas se anexa un resumen en markdown.
#
# Requisito del cluster destino: el rol de la aplicacion debe existir (lo crea
# docker/postgres/init/01-app-role.sh). El dump trae los GRANT pero no los roles;
# sin el rol, el restore falla.
#
# Salida: 0 si todas las verificaciones pasaron, 1 si alguna fallo.
# ---------------------------------------------------------------------------
set -eu

DESTINO="${1:-voxia_verificacion_restore}"
ROL_APP="${DATABASE_APP_USER:-voxia_app}"
UUID_PRUEBA='7f000000-0000-4000-8000-000000000001'
RUTA_RESTORE="$(dirname "$0")/restore.sh"

if [ -z "${PGDATABASE:-}" ]; then
  echo "ERROR: PGDATABASE no esta definida; no se sabe que base respaldar." >&2
  exit 1
fi

# Una verificacion jamas apunta a la base productiva. Aca no hay bandera de
# confirmacion a proposito: restaurar encima de produccion es el procedimiento
# de desastre (restore.sh), no una prueba.
if [ "$DESTINO" = "$PGDATABASE" ]; then
  echo "ERROR: el destino '$DESTINO' es la base de origen. La prueba necesita otra base." >&2
  exit 1
fi

if [ ! -f "$RUTA_RESTORE" ]; then
  echo "ERROR: no se encuentra restore.sh junto a este script ($RUTA_RESTORE)." >&2
  exit 1
fi

for BINARIO in pg_dump pg_restore psql createdb dropdb; do
  if ! command -v "$BINARIO" > /dev/null 2>&1; then
    echo "ERROR: falta $BINARIO en el entorno." >&2
    exit 1
  fi
done

TRABAJO=$(mktemp -d)

limpiar() {
  ESTADO=$?
  trap - EXIT INT TERM
  if [ "${CONSERVAR:-no}" = "si" ]; then
    echo "[verificar] CONSERVAR=si: queda la base '$DESTINO' y el dump en $TRABAJO"
  else
    rm -rf "$TRABAJO"
    dropdb --if-exists "$DESTINO" > /dev/null 2>&1 || true
  fi
  exit "$ESTADO"
}
trap limpiar EXIT INT TERM

ERRORES=0
AVISOS=0
ok() { echo "  [ok]    $*"; }
falla() { echo "  [FALLA] $*" >&2; ERRORES=$((ERRORES + 1)); }
avisar() { echo "  [aviso] $*"; AVISOS=$((AVISOS + 1)); }

# Una consulta que falla aborta el script (set -e): si la verificacion no puede
# correr, no hay resultado que reportar. Silenciarla seria peor que fallar.
consultar() {
  psql -d "$1" -qAtX -v ON_ERROR_STOP=1 -v rol_app="$ROL_APP" -c "$2"
}

# Siempre termina en exito: las diferencias se cuentan en ERRORES, no se
# propagan como codigo de salida. Asi el llamador no necesita `|| true`, que
# desactivaria set -e dentro de la funcion y dejaria pasar un psql caido con dos
# archivos vacios que "coinciden".
comparar() {
  ETIQUETA="$1"
  SQL="$2"
  consultar "$PGDATABASE" "$SQL" > "$TRABAJO/origen.crudo"
  consultar "$DESTINO" "$SQL" > "$TRABAJO/destino.crudo"
  sort "$TRABAJO/origen.crudo" > "$TRABAJO/origen.txt"
  sort "$TRABAJO/destino.crudo" > "$TRABAJO/destino.txt"
  if diff -u "$TRABAJO/origen.txt" "$TRABAJO/destino.txt" > "$TRABAJO/diferencias.txt"; then
    ok "$ETIQUETA: $(wc -l < "$TRABAJO/origen.txt" | tr -d ' ') coinciden"
  else
    falla "$ETIQUETA: el destino no coincide con el origen"
    sed 's/^/         /' "$TRABAJO/diferencias.txt" >&2
  fi
}

SQL_CONTEO_TABLAS=$(cat <<'SQL'
select count(*)::text
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
SQL
)

SQL_RLS=$(cat <<'SQL'
select c.relname::text || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
SQL
)

# Tablas de negocio (las que llevan tenant_id) sin ENABLE + FORCE. Sin FORCE, el
# dueño de la tabla se salta sus propias politicas: el aislamiento se evapora.
SQL_RLS_FALTANTE=$(cat <<'SQL'
select c.relname::text
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relkind = 'r'
  and exists (
    select 1 from pg_attribute a
    where a.attrelid = c.oid and a.attname = 'tenant_id'
      and a.attnum > 0 and not a.attisdropped
  )
  and not (c.relrowsecurity and c.relforcerowsecurity)
SQL
)

# Se comparan USING y WITH CHECK completos: una politica que sobrevive con la
# condicion cambiada es peor que una politica perdida, porque no se nota.
SQL_POLITICAS=$(cat <<'SQL'
select p.tablename::text || '|' || p.policyname::text || '|' || p.permissive::text
       || '|' || coalesce(p.roles::text, '') || '|' || p.cmd::text
       || '|' || replace(coalesce(p.qual, ''), chr(10), ' ')
       || '|' || replace(coalesce(p.with_check, ''), chr(10), ' ')
from pg_policies p
where p.schemaname = 'public'
SQL
)

SQL_FUNCIONES=$(cat <<'SQL'
select p.proname::text || '(' || pg_get_function_identity_arguments(p.oid) || ')'
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
SQL
)

SQL_FUNCIONES_FALTANTES=$(cat <<'SQL'
select requerida.nombre
from (values ('app_tenant_id'), ('app_has_audited_support_access')) as requerida(nombre)
where not exists (
  select 1
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = requerida.nombre
)
SQL
)

SQL_GRANTS=$(cat <<'SQL'
select c.relname::text || '|' || a.privilege_type
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(c.relacl) a
join pg_roles r on r.oid = a.grantee
where n.nspname = 'public' and c.relkind = 'r' and r.rolname = :'rol_app'
SQL
)

SQL_INDICES=$(cat <<'SQL'
select i.tablename::text || '|' || i.indexname::text || '|' || i.indexdef
from pg_indexes i
where i.schemaname = 'public'
SQL
)

# Genera un SELECT por tabla y los une; se ejecuta en cada base y se comparan las
# salidas. Es SQL plano a proposito: no depende de que el servidor traiga XML.
SQL_GENERAR_CONTEOS=$(cat <<'SQL'
select coalesce(
         string_agg(
           format('select %L || ''='' || (select count(*) from public.%I)::text', c.relname, c.relname),
           ' union all '
           order by c.relname
         ),
         'select null::text where false'
       )
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
SQL
)

conteo_filas() {
  SQL_GENERADO=$(consultar "$1" "$SQL_GENERAR_CONTEOS")
  consultar "$1" "$SQL_GENERADO" > "$TRABAJO/conteos.crudo"
  sort "$TRABAJO/conteos.crudo"
}

echo "== VERIFICACION DE RESTORE $(date '+%F %T') =="
echo "origen=$PGDATABASE  destino=$DESTINO  host=${PGHOST:-local}  rol_app=$ROL_APP"

# --- 1. Dump: mismo comando que el servicio postgres-backup ----------------
# Al directorio temporal, NUNCA a /backups: la prueba no debe pisar el dump del
# dia ni alterar la retencion.
ARCHIVO="$TRABAJO/voxia-verificacion-$(date +%F).dump"
INICIO_DUMP=$(date +%s)
echo "[1/3] pg_dump de '$PGDATABASE'"
if ! pg_dump -Fc -f "$ARCHIVO.part" "$PGDATABASE"; then
  rm -f "$ARCHIVO.part"
  echo "ERROR: pg_dump fallo; no hay nada que verificar." >&2
  exit 1
fi
mv "$ARCHIVO.part" "$ARCHIVO"
SEGUNDOS_DUMP=$(( $(date +%s) - INICIO_DUMP ))
TAMANO_DUMP=$(du -h "$ARCHIVO" | cut -f1)
echo "      dump listo: $TAMANO_DUMP en ${SEGUNDOS_DUMP}s"

# --- 2. Restore con el script del procedimiento manual ---------------------
echo "[2/3] restore en '$DESTINO' (via restore.sh)"
INICIO_RESTORE=$(date +%s)
if ! sh "$RUTA_RESTORE" "$ARCHIVO" "$DESTINO"; then
  echo "ERROR: restore.sh fallo. El dump no se puede restaurar." >&2
  exit 1
fi
SEGUNDOS_RESTORE=$(( $(date +%s) - INICIO_RESTORE ))

# --- 3. Verificaciones de contenido ----------------------------------------
echo "[3/3] verificaciones"

TABLAS_ORIGEN=$(consultar "$PGDATABASE" "$SQL_CONTEO_TABLAS")
TABLAS_DESTINO=$(consultar "$DESTINO" "$SQL_CONTEO_TABLAS")
if [ "$TABLAS_ORIGEN" -eq 0 ]; then
  falla "el origen no tiene tablas: comparar contra el destino no probaria nada"
elif [ "$TABLAS_ORIGEN" -ne "$TABLAS_DESTINO" ]; then
  falla "tablas: origen $TABLAS_ORIGEN, destino $TABLAS_DESTINO"
else
  ok "tablas: $TABLAS_DESTINO en origen y destino"
fi

comparar "RLS por tabla (enable/force)" "$SQL_RLS"

consultar "$DESTINO" "$SQL_RLS_FALTANTE" > "$TRABAJO/rls-faltante.txt"
if [ -s "$TRABAJO/rls-faltante.txt" ]; then
  falla "tablas con tenant_id sin ENABLE+FORCE en el destino:"
  sed 's/^/         /' "$TRABAJO/rls-faltante.txt" >&2
else
  ok "todas las tablas con tenant_id conservan RLS ENABLE y FORCE"
fi

comparar "politicas RLS (incluye USING y WITH CHECK)" "$SQL_POLITICAS"
comparar "funciones de public" "$SQL_FUNCIONES"

consultar "$DESTINO" "$SQL_FUNCIONES_FALTANTES" > "$TRABAJO/funciones-faltantes.txt"
if [ -s "$TRABAJO/funciones-faltantes.txt" ]; then
  falla "faltan funciones de las que dependen las politicas RLS:"
  sed 's/^/         /' "$TRABAJO/funciones-faltantes.txt" >&2
else
  ok "app_tenant_id y app_has_audited_support_access existen"
  # Que esten en pg_proc no prueba que el cuerpo sobrevivio. El tercer
  # parametro de set_config en true es SET LOCAL: no ensucia la sesion.
  PRUEBA=$(consultar "$DESTINO" "select (app_tenant_id() = '$UUID_PRUEBA'::uuid)::text || '|' || app_has_audited_support_access('$UUID_PRUEBA'::uuid)::text from (select set_config('app.tenant_id', '$UUID_PRUEBA', true)) as contexto")
  if [ "$PRUEBA" = "t|f" ]; then
    ok "las funciones corren: app_tenant_id lee el contexto y el acceso de soporte falla cerrado"
  else
    falla "las funciones no se comportan como deben (esperado 't|f', obtenido '$PRUEBA')"
  fi
fi

comparar "GRANT sobre tablas para $ROL_APP" "$SQL_GRANTS"
comparar "indices" "$SQL_INDICES"

conteo_filas "$PGDATABASE" > "$TRABAJO/filas-origen.txt"
conteo_filas "$DESTINO" > "$TRABAJO/filas-destino.txt"
FILAS_ORIGEN=$(awk -F= '{ suma += $2 } END { print suma + 0 }' "$TRABAJO/filas-origen.txt")
FILAS_DESTINO=$(awk -F= '{ suma += $2 } END { print suma + 0 }' "$TRABAJO/filas-destino.txt")

if [ "$FILAS_ORIGEN" -eq 0 ]; then
  falla "el origen no tiene filas: un restore vacio compararia 0 contra 0 y pasaria sin probar nada"
elif diff -u "$TRABAJO/filas-origen.txt" "$TRABAJO/filas-destino.txt" > "$TRABAJO/filas-diff.txt"; then
  ok "filas por tabla: $FILAS_DESTINO en origen y destino"
elif [ "${ORIGEN_EN_VIVO:-no}" = "si" ] && [ "$FILAS_DESTINO" -gt 0 ] && [ "$FILAS_DESTINO" -le "$FILAS_ORIGEN" ]; then
  # pg_dump usa un snapshot consistente: lo que llego despues del dump no esta
  # en el destino y no es un error. Revisar igual que la diferencia sea chica.
  avisar "filas por tabla: origen $FILAS_ORIGEN, destino $FILAS_DESTINO (ORIGEN_EN_VIVO=si, escrituras posteriores al dump)"
  sed 's/^/         /' "$TRABAJO/filas-diff.txt"
else
  falla "filas por tabla: origen $FILAS_ORIGEN, destino $FILAS_DESTINO"
  sed 's/^/         /' "$TRABAJO/filas-diff.txt" >&2
fi

# --- Resultado --------------------------------------------------------------
echo ""
echo "== RESULTADO =="
echo "dump:            $TAMANO_DUMP en ${SEGUNDOS_DUMP}s"
echo "restore:         ${SEGUNDOS_RESTORE}s   <-- tiempo de recuperacion de la base"
echo "tablas:          $TABLAS_DESTINO"
echo "filas:           $FILAS_DESTINO"
echo "verificaciones:  $ERRORES fallas, $AVISOS avisos"

if [ "$ERRORES" -eq 0 ]; then
  ESTADO_TEXTO="OK"
else
  ESTADO_TEXTO="FALLO"
fi

if [ -n "${RESUMEN_ARCHIVO:-}" ]; then
  {
    echo "### Prueba de restore: $ESTADO_TEXTO"
    echo ""
    echo "| dato | valor |"
    echo "|---|---|"
    echo "| fecha | $(date '+%F %T') |"
    echo "| origen | \`$PGDATABASE\` |"
    echo "| destino | \`$DESTINO\` |"
    echo "| tamaño del dump | $TAMANO_DUMP |"
    echo "| duracion del dump | ${SEGUNDOS_DUMP}s |"
    echo "| **duracion del restore** | **${SEGUNDOS_RESTORE}s** |"
    echo "| tablas | $TABLAS_DESTINO |"
    echo "| filas | $FILAS_DESTINO |"
    echo "| fallas | $ERRORES |"
    echo "| avisos | $AVISOS |"
    echo ""
    if [ "$ERRORES" -ne 0 ]; then
      echo "Revisar el log del job: cada falla imprime el diff entre origen y destino."
    fi
  } >> "$RESUMEN_ARCHIVO"
fi

if [ "$ERRORES" -ne 0 ]; then
  echo "VERIFICACION FALLIDA: el dump se restauro pero el resultado no sirve." >&2
  exit 1
fi

echo "VERIFICACION OK: el dump se restauro y el resultado sirve."
