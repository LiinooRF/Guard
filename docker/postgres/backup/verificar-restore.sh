#!/bin/sh
# ---------------------------------------------------------------------------
# Prueba de restore de SentryCore: dump -> restore -> VERIFICAR CONTENIDO.
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
#        - CON EL ROL DE LA APLICACION: con contexto de tenant se ve ese tenant
#          y solo ese, y sin contexto no se ve NADA. Es la prueba de que el
#          aislamiento entre empresas sobrevivio al restore, no solo de que las
#          politicas figuran en el catalogo.
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
#     sh /scripts/verificar-restore.sh sentrycore_verificacion_restore
#
# Uso en CI: .github/workflows/backup-restore.yml lo corre dentro de una imagen
# postgres:17-alpine —la misma del servicio de backup— contra el Postgres del job.
#
# Entorno que espera:
#   PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE  del DUEÑO de la base, los mismos
#     que usa postgres-backup. sentrycore_app no sirve: no puede crear bases y RLS le
#     cierra la lectura sin contexto de tenant, asi que el dump saldria vacio.
#   DATABASE_APP_USER   rol de la aplicacion cuyos GRANT se comparan (sentrycore_app).
#   DUMP_EXISTENTE      ruta a un dump YA HECHO. Con esto el script no toma uno
#                       nuevo: restaura ESE archivo. Es la diferencia entre
#                       probar "un dump hecho igual que el del servicio" y
#                       probar el respaldo de verdad —incluido el que se bajo de
#                       vuelta desde fuera del VPS, que es lo unico que
#                       demuestra que la copia remota sirve.
#   CONSERVAR=si        no borra la base de prueba ni el dump al terminar.
#                       Necesario si despues se va a arrancar la API contra la
#                       base restaurada.
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

DESTINO="${1:-sentrycore_verificacion_restore}"
ROL_APP="${DATABASE_APP_USER:-sentrycore_app}"
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
#
# Por STDIN, no `-c`: psql solo interpola sus variables (:'rol_app' en
# SQL_GRANTS) cuando lee de un archivo o de stdin, NO dentro del argumento de
# `-c` -se descubrio en CI, con "syntax error at or near ':'" porque el texto
# le llegaba literal al servidor. El patron de mas abajo (contar_sites_como_app)
# ya lo hacia bien por stdin; esto lo alinea.
consultar() {
  printf '%s' "$2" | psql -d "$1" -qAtX -v ON_ERROR_STOP=1 -v rol_app="$ROL_APP"
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
if [ -n "${DUMP_EXISTENTE:-}" ]; then
  # No se copia a $TRABAJO: se restaura el archivo tal cual esta, y la limpieza
  # de $TRABAJO no lo toca porque vive afuera.
  if [ ! -f "$DUMP_EXISTENTE" ]; then
    echo "ERROR: DUMP_EXISTENTE no existe: $DUMP_EXISTENTE" >&2
    exit 1
  fi
  ARCHIVO="$DUMP_EXISTENTE"
  ORIGEN_DUMP="archivo existente"
  SEGUNDOS_DUMP=0
  TAMANO_DUMP=$(du -h "$ARCHIVO" | cut -f1)
  echo "[1/3] usando un dump ya hecho: $ARCHIVO ($TAMANO_DUMP)"
else
  ARCHIVO="$TRABAJO/sentrycore-verificacion-$(date +%F).dump"
  ORIGEN_DUMP="pg_dump nuevo"
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
fi

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
  if [ "$PRUEBA" = "t|f" ] || [ "$PRUEBA" = "true|false" ]; then
    ok "las funciones corren: app_tenant_id lee el contexto y el acceso de soporte falla cerrado"
  else
    falla "las funciones no se comportan como deben (esperado 'true|false' o 't|f', obtenido '$PRUEBA')"
  fi
fi

comparar "GRANT sobre tablas para $ROL_APP" "$SQL_GRANTS"
comparar "indices" "$SQL_INDICES"

# --- Aislamiento entre empresas, con el rol de la aplicacion ----------------
# Todo lo anterior mira el catalogo: que las politicas figuren y digan lo mismo.
# Esto lee datos como los lee la API y comprueba el resultado.
#
# `SET LOCAL ROLE` cambia el rol dentro de la transaccion. Importa que sea el
# rol de la app y no el dueño: el dueño de esta base es superusuario y el
# superusuario se salta RLS entero, asi que "probar" el aislamiento con el
# mismo usuario que hace el dump daria verde siempre y no probaria nada.
#
# Se lee `sites` porque lleva tenant_id desde su migracion original
# (1722524400000-CreateDemoDomain.ts: id, tenant_id, branch_name, name,
# address, latitude, longitude, timezone, is_active, created_at).
SQL_TABLA_SITES=$(cat <<'SQL'
select count(*)::text
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relname = 'sites'
SQL
)

# Los conteos reales por tenant, leidos como dueño (sin RLS de por medio): son
# el numero contra el que se compara lo que ve la aplicacion.
SQL_SITES_POR_TENANT=$(cat <<'SQL'
select tenant_id::text || '=' || count(*)::text
from public.sites
group by tenant_id
order by 1
SQL
)

# Marca la linea del conteo. Sin la marca habria que adivinar cual de las
# lineas que imprime psql es el resultado, y un tag de comando ("COMMIT") se
# colaria como si fuera un numero.
contar_sites_como_app() {
  if [ -n "$1" ]; then
    psql -d "$DESTINO" -qAtX -v ON_ERROR_STOP=1 -v rol_app="$ROL_APP" -v tenant="$1" <<'SQL' | sed -n 's/^CONTEO=//p'
BEGIN;
SET LOCAL ROLE :"rol_app";
SELECT set_config('app.tenant_id', :'tenant', true);
SELECT 'CONTEO=' || count(*)::text FROM public.sites;
COMMIT;
SQL
  else
    psql -d "$DESTINO" -qAtX -v ON_ERROR_STOP=1 -v rol_app="$ROL_APP" <<'SQL' | sed -n 's/^CONTEO=//p'
BEGIN;
SET LOCAL ROLE :"rol_app";
SELECT 'CONTEO=' || count(*)::text FROM public.sites;
COMMIT;
SQL
  fi
}

if [ "$(consultar "$DESTINO" "$SQL_TABLA_SITES")" -eq 0 ]; then
  avisar "no existe la tabla 'sites' en el destino: se omite la prueba de aislamiento"
else
  consultar "$DESTINO" "$SQL_SITES_POR_TENANT" > "$TRABAJO/sites-por-tenant.txt"
  TOTAL_SITES=$(awk -F= '{ suma += $2 } END { print suma + 0 }' "$TRABAJO/sites-por-tenant.txt")

  # Sin contexto de tenant no se ve NADA. Es la regla de "fallar cerrada": si
  # esto devuelve filas, la politica abre cuando el valor esta vacio y cualquier
  # consulta sin contexto ve datos de todas las empresas.
  SIN_CONTEXTO=$(contar_sites_como_app "")
  if [ "$SIN_CONTEXTO" = "0" ]; then
    ok "sin contexto de tenant, $ROL_APP no ve ninguna fila (la politica falla cerrada)"
  else
    falla "sin contexto de tenant, $ROL_APP ve $SIN_CONTEXTO fila(s) de 'sites': la politica NO falla cerrada"
  fi

  if [ "$TOTAL_SITES" -eq 0 ]; then
    avisar "no hay filas en 'sites': no se puede comprobar que cada tenant vea las suyas"
  else
    REVISADOS=0
    # Dos tenants alcanzan para probar el cruce y mantienen la prueba corta en
    # una base con muchas empresas.
    while IFS='=' read -r TENANT ESPERADO; do
      if [ -z "$TENANT" ]; then
        continue
      fi
      if [ "$REVISADOS" -ge 2 ]; then
        break
      fi
      REVISADOS=$((REVISADOS + 1))
      VISTO=$(contar_sites_como_app "$TENANT")
      if [ "$VISTO" != "$ESPERADO" ]; then
        falla "con contexto de un tenant, $ROL_APP ve $VISTO filas y le corresponden $ESPERADO"
      elif [ "$ESPERADO" -eq "$TOTAL_SITES" ]; then
        # Con un solo tenant en la base, ver "todo" y ver "lo suyo" es el mismo
        # numero: la comparacion no distingue una politica rota de una sana.
        ok "con contexto de tenant, $ROL_APP ve sus $VISTO filas (hay un solo tenant: no prueba el cruce)"
      else
        ok "con contexto de tenant, $ROL_APP ve sus $VISTO filas y no las $((TOTAL_SITES - ESPERADO)) de las otras empresas"
      fi
    done < "$TRABAJO/sites-por-tenant.txt"
  fi
fi

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
echo "dump:            $TAMANO_DUMP ($ORIGEN_DUMP) en ${SEGUNDOS_DUMP}s"
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
    echo "| origen del dump | $ORIGEN_DUMP |"
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
