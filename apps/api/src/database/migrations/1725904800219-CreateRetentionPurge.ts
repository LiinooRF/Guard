import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Purga por retencion de datos (#219).
 *
 * EL PROBLEMA
 * -----------
 * Hoy nada se borra nunca. `photoRetentionDays` y `gpsTrackRetentionDays` estan
 * en el catalogo de reglas desde #81, el admin los puede editar, y no hacen
 * absolutamente nada: la evidencia y la traza del guardia se acumulan para
 * siempre. Para un producto que rastrea a trabajadores eso no es solo disco, es
 * el incumplimiento del principio de proporcionalidad (ver CLAUDE.md,
 * "rastrear a un trabajador tiene requisitos legales").
 *
 * QUIEN BORRA, Y POR QUE NO PUEDE SER sentrycore_app
 * ---------------------------------------------
 * `scan_photos` y `event_photos` son APPEND-ONLY a nivel de PostgreSQL: el rol
 * de la aplicacion tiene GRANT SELECT, INSERT y REVOKE UPDATE, DELETE. Esa
 * propiedad es la que hace que la evidencia sirva como prueba en un juicio
 * laboral, y darle DELETE a sentrycore_app para poder purgar la destruiria: pasaria
 * de "la aplicacion NO PUEDE borrar" a "la aplicacion promete no borrar", que
 * no es un control, es una intencion (mismo argumento con el que la migracion
 * de event_photos justifica su REVOKE).
 *
 * La salida es la que ya sanciono el proyecto en `report_dispatch_backlog` y en
 * `platform_purge_tenant`: funciones SECURITY DEFINER. Corren como el DUEÑO de
 * las tablas —el rol de migraciones, que es superusuario y por eso si se salta
 * RLS— y no como sentrycore_app, que sigue sin BYPASSRLS y sigue sin DELETE. Lo que
 * la aplicacion gana es EXECUTE sobre seis funciones estrechas, no un permiso
 * sobre las tablas.
 *
 * Y esas funciones estan acotadas por construccion:
 *   - Solo borran filas ANTERIORES al corte, y el corte se calcula aca adentro
 *     a partir de los dias que le pasan. Aunque el llamador pida borrar por id
 *     una foto de hoy, el `created_at < corte` del DELETE la deja pasar.
 *   - `retencion_dias_efectivos` aplica un PISO por conjunto. Un override
 *     corrupto que diga "1 dia" no puede vaciar la evidencia: el piso lo sube a
 *     30. El piso vive en la base y no solo en el codigo a proposito: es el
 *     ultimo cerrojo y tiene que seguir puesto aunque la API este comprometida.
 *   - Exigen NO tener contexto de tenant, igual que report_dispatch_backlog. Es
 *     el unico cerrojo que un worker puede cumplir (no tiene rol ni usuario) y
 *     cierra las funciones para CUALQUIER request, que siempre setea
 *     `app.tenant_id`. Ningun endpoint puede purgar, ni por error ni por abuso.
 *
 * POR QUE HAY UNA TABLA DE BARRIDOS Y NO SOLO UN `LIMIT`
 * ------------------------------------------------------
 * `retencion_tenants` tiene un techo de empresas por pasada. La primera version
 * de esta migracion las ordenaba por `empresa.id` y nada achicaba el conjunto
 * entre pasadas, asi que con el techo en 500 y 501 empresas, la 501 no se
 * purgaba JAMAS: cada pasada volvia a barrer exactamente las mismas 500, sin
 * error y con el log diciendo `{"tenants":500}`. Un incumplimiento silencioso
 * del plazo legal, que es el peor modo de fallar que tiene este carril.
 *
 * `report_dispatch_backlog` no tiene ese problema porque su conjunto SI se
 * achica: descarta las rondas que ya tienen entrega o marca de intento. La
 * purga no puede copiar eso —una empresa nunca "termina" de purgarse, le llega
 * evidencia nueva todos los dias— asi que lo que se copia es la idea: una marca
 * por empresa con CUANDO se la barrio por ultima vez, y el orden de la pasada
 * es esa marca ascendente con las nunca barridas primero. Sale una rotacion:
 * con N empresas y techo T, ninguna espera mas de ceil(N/T) pasadas.
 *
 * Lo que NO sirve para esto es ordenar por `retention_purge_runs`: esa bitacora
 * solo recibe fila cuando se borro algo (`rows_deleted > 0`), asi que una
 * empresa sin nada vencido nunca aparece ahi, quedaria eternamente primera en
 * el orden y volveria a tapar a las de atras. La marca de barrido se escribe
 * SIEMPRE, se haya borrado algo o no; son dos preguntas distintas y por eso son
 * dos tablas distintas.
 *
 * QUE NO SE PURGA, A PROPOSITO
 * ----------------------------
 * `field_events` y `audit_log` NO entran. El libro de novedades y la auditoria
 * son el registro que termina en juicios laborales y en fiscalizaciones;
 * borrarlos por antiguedad es exactamente lo que hace que dejen de servir como
 * prueba. Si algun dia hay que acotarlos es una decision del equipo con abogado
 * al lado, no un efecto colateral de una purga de disco. `event_photos` si es
 * purgable por estas funciones, pero la regla que lo habilita todavia no existe
 * en rules.ts y el default del servicio es NUNCA: ver INTEGRACION.md.
 *
 * COMO QUEDA AUDITADO
 * -------------------
 * `retention_purge_runs` es la bitacora, y la escribe la MISMA funcion en la
 * MISMA transaccion que el DELETE: no hay forma de borrar sin dejar la fila ni
 * de dejar la fila sin haber borrado. sentrycore_app recibe SELECT y nada mas —ni
 * siquiera INSERT—, asi que el ADMIN puede responder "que se borro de mi
 * empresa, cuando y con que ventana" y nadie desde la aplicacion puede maquillar
 * esa respuesta.
 *
 * SOBRE LOS NOMBRES DE LOS PARAMETROS
 * -----------------------------------
 * Los parametros y las columnas de salida se llaman en español (`conjunto`,
 * `dias_pedidos`, `filas_borradas`) y no como las columnas de las tablas. No es
 * estetica: en plpgsql un parametro que se llama igual que una columna del
 * INSERT o del WHERE es una ambiguedad que PostgreSQL resuelve lanzando error en
 * tiempo de EJECUCION, no al crear la funcion. Con nombres distintos el choque
 * no puede ocurrir.
 */
export class CreateRetentionPurge1725904800219 implements MigrationInterface {
  name = 'CreateRetentionPurge1725904800219';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE retention_purge_runs (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id uuid NOT NULL,
        dataset text NOT NULL
          CONSTRAINT retention_purge_runs_dataset_check
          CHECK (dataset IN ('patrol_tracks', 'scan_photos', 'event_photos')),
        -- Dias EFECTIVOS, ya con el piso aplicado. Se guarda el efectivo y no lo
        -- que pedia la configuracion porque esta fila responde "que ventana se
        -- aplico de verdad", que es la pregunta del reclamo.
        retention_days integer NOT NULL
          CONSTRAINT retention_purge_runs_days_check CHECK (retention_days > 0),
        cutoff timestamptz NOT NULL,
        rows_deleted integer NOT NULL
          CONSTRAINT retention_purge_runs_rows_check CHECK (rows_deleted > 0),
        bytes_freed bigint NOT NULL DEFAULT 0
          CONSTRAINT retention_purge_runs_bytes_check CHECK (bytes_freed >= 0),
        executed_at timestamptz NOT NULL DEFAULT now(),
        -- CASCADE y no RESTRICT: el borrado completo de un tenant (#33) verifica
        -- que no quede NINGUNA fila con ese tenant_id en ninguna tabla y aborta
        -- si queda alguna. Sin esta FK, la bitacora de purgas dejaria huerfanas
        -- que bloquearian el purge del tenant para siempre. La prueba juridica
        -- de ESE borrado vive en tenant_deletions, que no tiene FK y sobrevive;
        -- esta bitacora es del ciclo de vida del tenant y muere con el.
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE INDEX retention_purge_runs_tenant_idx
      ON retention_purge_runs (tenant_id, executed_at DESC)
    `);

    await queryRunner.query(`ALTER TABLE retention_purge_runs ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE retention_purge_runs FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY retention_purge_runs_isolation ON retention_purge_runs
      FOR ALL
      USING (
        tenant_id = app_tenant_id()
        OR app_has_audited_support_access(tenant_id)
      )
      WITH CHECK (tenant_id = app_tenant_id())
    `);

    /*
     * La marca de rotacion del barrido: CUANDO se atendio por ultima vez a cada
     * empresa. Va antes que las funciones porque `retencion_tenants` la
     * consulta y PostgreSQL valida el cuerpo de una funcion `LANGUAGE sql` al
     * crearla.
     *
     * Una fila por empresa y nada mas que la fecha. NO es la bitacora de lo que
     * se borro —esa es retention_purge_runs, que el ADMIN lee— sino el cursor
     * del barrido: se escribe aunque la pasada no haya borrado ni una fila, y
     * tambien cuando la empresa fallo. Que una empresa rota se marque igual es
     * deliberado: si no se marcara, se quedaria pegada a la cabeza del orden y
     * volveria a tapar a las de atras, que es exactamente el bug que esta tabla
     * viene a arreglar. Lo que pasa hoy con una empresa rota es que se reintenta
     * una vez por vuelta y su fallo queda en el log, no que se pierda.
     *
     * Mismo CASCADE que retention_purge_runs y por el mismo motivo (#33).
     */
    await queryRunner.query(`
      CREATE TABLE retention_tenant_sweeps (
        tenant_id uuid PRIMARY KEY,
        swept_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
      )
    `);

    // Sin indice sobre swept_at a proposito: el orden de la pasada recorre
    // `tenants` entera (necesita tambien a las que NUNCA se barrieron, que no
    // tienen fila aca), asi que el planificador ordena en memoria de todos
    // modos. Un indice seria peso muerto en cada escritura del barrido.

    await queryRunner.query(`ALTER TABLE retention_tenant_sweeps ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE retention_tenant_sweeps FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY retention_tenant_sweeps_isolation ON retention_tenant_sweeps
      FOR ALL
      USING (
        tenant_id = app_tenant_id()
        OR app_has_audited_support_access(tenant_id)
      )
      WITH CHECK (tenant_id = app_tenant_id())
    `);

    /*
     * Los indices por los que barre la purga.
     *
     * patrol_tracks ya tiene el suyo desde 1724511600000. scan_photos solo tenia
     * (tenant_id, patrol_id, created_at) y event_photos (tenant_id, event_id,
     * created_at): ninguno sirve para "lo mas viejo de esta empresa", porque el
     * prefijo del indice es la ronda o la novedad. Sin estos, cada pasada seria
     * un recorrido completo de las dos tablas mas grandes del producto.
     */
    await queryRunner.query(
      `CREATE INDEX scan_photos_retention_idx ON scan_photos (tenant_id, created_at)`,
    );
    await queryRunner.query(
      `CREATE INDEX event_photos_retention_idx ON event_photos (tenant_id, created_at)`,
    );

    /*
     * El piso de retencion, y el cerrojo de "solo sin contexto de tenant".
     *
     * Los pisos son ESPEJO del min de cada regla en packages/shared/src/rules.ts
     * (photoRetentionDays min 30, gpsTrackRetentionDays min 7). El zod valida lo
     * que ENTRA por la API; esto protege de lo que ya esta GUARDADO: un override
     * escrito a mano, una restauracion vieja o un panel de otra version pueden
     * dejar un valor fuera de rango en tenant_rules, y la purga es irreversible.
     * Hay un test que compara estos dos numeros contra el zod para que no se
     * separen en silencio (purga-retencion.migration.spec.ts).
     *
     * event_photos usa el mismo piso que las fotos de ronda: es evidencia del
     * mismo tipo, del mismo tamaño y con el mismo valor probatorio.
     */
    await queryRunner.query(`
      CREATE FUNCTION retencion_dias_efectivos(conjunto text, dias_pedidos integer)
      RETURNS integer
      LANGUAGE plpgsql
      STABLE
      SET search_path = pg_catalog, public
      AS $$
      DECLARE
        piso integer;
      BEGIN
        IF NULLIF(current_setting('app.tenant_id', true), '') IS NOT NULL THEN
          RAISE EXCEPTION 'la purga de retencion no corre dentro de una sesion con tenant'
            USING ERRCODE = '42501';
        END IF;

        piso := CASE conjunto
                  WHEN 'patrol_tracks' THEN 7
                  WHEN 'scan_photos' THEN 30
                  WHEN 'event_photos' THEN 30
                END;

        IF piso IS NULL THEN
          RAISE EXCEPTION 'el conjunto % no se purga por retencion', conjunto
            USING ERRCODE = '22023';
        END IF;

        IF dias_pedidos IS NULL OR dias_pedidos < 1 THEN
          RAISE EXCEPTION 'retencion invalida para %: %', conjunto, dias_pedidos
            USING ERRCODE = '22023';
        END IF;

        RETURN GREATEST(dias_pedidos, piso);
      END
      $$
    `);

    /*
     * Las empresas a barrer, EN ORDEN DE ROTACION. SOLO identificadores, igual
     * que report_dispatch_backlog: ni nombre, ni correo, ni conteos.
     *
     * `swept_at ASC NULLS FIRST` es lo que hace que el techo de `max_rows` sea
     * un techo de trabajo por pasada y no una lista fija de privilegiados: las
     * nunca barridas van primero (una empresa nueva no espera una vuelta
     * entera), y detras las que hace mas tiempo que no se atienden. Sin este
     * orden, el `LIMIT` convertia a las primeras N empresas por id en las unicas
     * que se purgan.
     *
     * El `empresa.id` del final es solo desempate, para que dos pasadas con el
     * mismo `swept_at` —o con la tabla recien creada, donde todas son NULL— no
     * devuelvan un orden distinto cada vez.
     *
     * No filtra por `tenants.status`. Una empresa suspendida sigue teniendo
     * datos personales de trabajadores guardados y el plazo para borrarlos corre
     * igual: cortarle el servicio no la exime de la retencion.
     */
    await queryRunner.query(`
      CREATE FUNCTION retencion_tenants(max_rows integer)
      RETURNS TABLE (tenant_id uuid)
      LANGUAGE sql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
        SELECT empresa.id
        FROM public.tenants empresa
        LEFT JOIN public.retention_tenant_sweeps barrido
          ON barrido.tenant_id = empresa.id
        WHERE NULLIF(current_setting('app.tenant_id', true), '') IS NULL
        ORDER BY barrido.swept_at ASC NULLS FIRST, empresa.id
        LIMIT max_rows
      $$
    `);

    /*
     * "Esta empresa ya se atendio en esta pasada".
     *
     * La escribe el barrido al terminar con cada empresa, HAYA BORRADO O NO, y
     * tambien si la empresa fallo. Es lo unico que hace avanzar la rotacion.
     *
     * Que una empresa borrada entre el listado y la marca no sea un error es
     * deliberado: una pasada dura minutos y #33 puede correr en el medio. Sin el
     * chequeo, la FK abortaria la marca y el barrido registraria un fallo que no
     * existe.
     */
    await queryRunner.query(`
      CREATE FUNCTION retencion_marcar_barrido(target_tenant uuid)
      RETURNS void
      LANGUAGE plpgsql
      VOLATILE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      BEGIN
        IF NULLIF(current_setting('app.tenant_id', true), '') IS NOT NULL THEN
          RAISE EXCEPTION 'la purga de retencion no corre dentro de una sesion con tenant'
            USING ERRCODE = '42501';
        END IF;

        IF NOT EXISTS (SELECT 1 FROM public.tenants empresa WHERE empresa.id = target_tenant) THEN
          RETURN;
        END IF;

        INSERT INTO public.retention_tenant_sweeps (tenant_id, swept_at)
        VALUES (target_tenant, now())
        ON CONFLICT (tenant_id) DO UPDATE SET swept_at = now();
      END
      $$
    `);

    /*
     * Las fotos vencidas de una empresa. Devuelve la RUTA porque el archivo en
     * disco es parte de lo que hay que purgar: borrar la fila y dejar el binario
     * bajo EVIDENCE_PATH no es purgar, es perder el indice de lo que se sigue
     * guardando.
     *
     * Va SEPARADA del DELETE a proposito. El servicio borra primero el archivo y
     * recien despues manda a borrar las filas cuyo archivo confirmo que ya no
     * esta. Al reves —fila primero, archivo despues— cualquier fallo de disco
     * deja un huerfano permanente del que ya nadie sabe de quien era.
     *
     * POR QUE RECIBE `excluir`
     * ------------------------
     * Justamente porque devuelve las mas viejas primero. Una foto cuyo archivo
     * no se pudo borrar CONSERVA su fila, asi que sigue siendo la mas vieja y
     * vuelve a salir la primera en el lote siguiente, y en el siguiente. Sin
     * excluirla, cada lote de la pasada arrancaba reintentando los mismos
     * archivos trabados: el contador de conservadas los sumaba una vez por lote
     * (numero inventado para el operador que decide si el volumen esta roto) y,
     * si los trabados llegaban a llenar un lote, tapaban a TODA la evidencia
     * vencida que venia detras — un archivo con permisos mal puestos dejaba a la
     * empresa entera sin purgar.
     *
     * `<> ALL` con el arreglo vacio es verdadero, asi que la primera llamada de
     * la pasada —que manda '{}'— no filtra nada. Lo que si seria veneno es un
     * NULL adentro del arreglo: `id <> ALL` con un NULL devuelve NULL para
     * TODAS las filas, la funcion contestaria vacio y la purga se detendria en
     * silencio, que es exactamente el modo de fallar que este carril no puede
     * permitirse. Por eso se limpian antes de usarlos.
     */
    await queryRunner.query(`
      CREATE FUNCTION retencion_fotos_vencidas(
        target_tenant uuid,
        conjunto text,
        dias_pedidos integer,
        max_rows integer,
        excluir uuid[]
      )
      RETURNS TABLE (foto_id uuid, ruta_relativa text, peso_bytes bigint)
      LANGUAGE plpgsql
      STABLE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      DECLARE
        corte timestamptz;
        omitidas uuid[];
      BEGIN
        IF conjunto NOT IN ('scan_photos', 'event_photos') THEN
          RAISE EXCEPTION 'el conjunto % no tiene evidencia en disco', conjunto
            USING ERRCODE = '22023';
        END IF;

        corte := now()
          - make_interval(days => public.retencion_dias_efectivos(conjunto, dias_pedidos));

        -- El alias lleva tabla Y columna con nombres distintos (excluida /
        -- elemento) por el mismo motivo que los parametros no se llaman como
        -- las columnas: un solo nombre para las dos cosas se resuelve al
        -- EJECUTAR, no al crear la funcion, y este cuerpo no se puede permitir
        -- descubrir una ambiguedad en produccion.
        SELECT coalesce(array_agg(excluida.elemento), '{}'::uuid[])
        INTO omitidas
        FROM unnest(coalesce(excluir, '{}'::uuid[])) AS excluida(elemento)
        WHERE excluida.elemento IS NOT NULL;

        IF conjunto = 'scan_photos' THEN
          RETURN QUERY
            SELECT foto.id, foto.storage_path, foto.size_bytes
            FROM public.scan_photos foto
            WHERE foto.tenant_id = target_tenant
              AND foto.created_at < corte
              AND foto.id <> ALL(omitidas)
            ORDER BY foto.created_at
            LIMIT max_rows;
        ELSE
          RETURN QUERY
            SELECT foto.id, foto.storage_path, foto.size_bytes
            FROM public.event_photos foto
            WHERE foto.tenant_id = target_tenant
              AND foto.created_at < corte
              AND foto.id <> ALL(omitidas)
            ORDER BY foto.created_at
            LIMIT max_rows;
        END IF;
      END
      $$
    `);

    /*
     * El DELETE de las fotos cuyo archivo ya se borro, y su bitacora.
     *
     * Vuelve a comprobar `created_at < corte` aunque el llamador haya pedido esos
     * ids con la misma ventana: la lista viaja por la aplicacion, y una funcion
     * que borrara por id sin revalidar la ventana seria una primitiva de borrado
     * arbitrario de evidencia con solo tener EXECUTE. Con la revalidacion, lo
     * peor que puede hacer un llamador equivocado es borrar algo que igual se iba
     * a borrar en la proxima pasada.
     *
     * El conteo sale de un CTE con RETURNING y no del rowCount del driver: en
     * TypeORM un DELETE devuelve [filas, rowCount] y leerlo como arreglo cuenta 2
     * siempre.
     */
    await queryRunner.query(`
      CREATE FUNCTION retencion_purgar_fotos(
        target_tenant uuid,
        conjunto text,
        dias_pedidos integer,
        ids_fotos uuid[]
      )
      RETURNS TABLE (filas_borradas integer, bytes_liberados bigint)
      LANGUAGE plpgsql
      VOLATILE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      DECLARE
        dias integer;
        corte timestamptz;
        cuenta integer := 0;
        peso bigint := 0;
      BEGIN
        IF conjunto NOT IN ('scan_photos', 'event_photos') THEN
          RAISE EXCEPTION 'el conjunto % no tiene evidencia en disco', conjunto
            USING ERRCODE = '22023';
        END IF;

        dias := public.retencion_dias_efectivos(conjunto, dias_pedidos);
        corte := now() - make_interval(days => dias);

        IF ids_fotos IS NULL OR array_length(ids_fotos, 1) IS NULL THEN
          RETURN QUERY SELECT 0, 0::bigint;
          RETURN;
        END IF;

        IF conjunto = 'scan_photos' THEN
          WITH borrado AS (
            DELETE FROM public.scan_photos foto
            WHERE foto.tenant_id = target_tenant
              AND foto.id = ANY(ids_fotos)
              AND foto.created_at < corte
            RETURNING foto.size_bytes AS bytes_fila
          )
          SELECT count(*)::integer, coalesce(sum(borrado.bytes_fila), 0)::bigint
          INTO cuenta, peso
          FROM borrado;
        ELSE
          WITH borrado AS (
            DELETE FROM public.event_photos foto
            WHERE foto.tenant_id = target_tenant
              AND foto.id = ANY(ids_fotos)
              AND foto.created_at < corte
            RETURNING foto.size_bytes AS bytes_fila
          )
          SELECT count(*)::integer, coalesce(sum(borrado.bytes_fila), 0)::bigint
          INTO cuenta, peso
          FROM borrado;
        END IF;

        IF cuenta > 0 THEN
          INSERT INTO public.retention_purge_runs (
            tenant_id, dataset, retention_days, cutoff, rows_deleted, bytes_freed
          ) VALUES (target_tenant, conjunto, dias, corte, cuenta, peso);
        END IF;

        RETURN QUERY SELECT cuenta, peso;
      END
      $$
    `);

    /*
     * La traza del recorrido. No tiene archivo en disco, asi que es una sola
     * funcion: elige el lote mas viejo y lo borra en la misma sentencia.
     *
     * Es la mas voluminosa de las tres (un punto por minuto son ~480 filas por
     * turno de 8 horas y por guardia) y la mas invasiva, porque es donde anduvo
     * una persona. Por eso su regla trae un default mucho mas corto que el de las
     * fotos y su piso es de 7 dias y no de 30.
     */
    await queryRunner.query(`
      CREATE FUNCTION retencion_purgar_trazas(
        target_tenant uuid,
        dias_pedidos integer,
        max_rows integer
      )
      RETURNS integer
      LANGUAGE plpgsql
      VOLATILE
      SECURITY DEFINER
      SET search_path = pg_catalog, public
      AS $$
      DECLARE
        dias integer;
        corte timestamptz;
        cuenta integer := 0;
      BEGIN
        dias := public.retencion_dias_efectivos('patrol_tracks', dias_pedidos);
        corte := now() - make_interval(days => dias);

        WITH vencidas AS (
          SELECT traza.id
          FROM public.patrol_tracks traza
          WHERE traza.tenant_id = target_tenant
            AND traza.created_at < corte
          ORDER BY traza.created_at
          LIMIT max_rows
        ), borrado AS (
          DELETE FROM public.patrol_tracks traza
          USING vencidas
          WHERE traza.tenant_id = target_tenant
            AND traza.id = vencidas.id
          RETURNING traza.id
        )
        SELECT count(*)::integer INTO cuenta FROM borrado;

        IF cuenta > 0 THEN
          INSERT INTO public.retention_purge_runs (
            tenant_id, dataset, retention_days, cutoff, rows_deleted, bytes_freed
          ) VALUES (target_tenant, 'patrol_tracks', dias, corte, cuenta, 0);
        END IF;

        RETURN cuenta;
      END
      $$
    `);

    await queryRunner.query(`
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
          -- La bitacora de purgas se LEE y no se escribe desde la aplicacion. Ni
          -- siquiera INSERT: la escribe la funcion SECURITY DEFINER junto con el
          -- DELETE. El script de init deja ALTER DEFAULT PRIVILEGES con los
          -- cuatro verbos, asi que el REVOKE no es adorno.
          GRANT SELECT ON retention_purge_runs TO sentrycore_app;
          REVOKE INSERT, UPDATE, DELETE ON retention_purge_runs FROM sentrycore_app;

          -- Idem con el cursor del barrido: lo escribe retencion_marcar_barrido,
          -- que es SECURITY DEFINER y exige no tener contexto de tenant. Con
          -- UPDATE directo, cualquier request podria atrasarle la marca a su
          -- propia empresa y sacarla de la rotacion — o sea, dejar de purgar sus
          -- datos sin que nadie lo note.
          GRANT SELECT ON retention_tenant_sweeps TO sentrycore_app;
          REVOKE INSERT, UPDATE, DELETE ON retention_tenant_sweeps FROM sentrycore_app;
        END IF;
      END
      $$
    `);

    // Nadie por defecto y EXECUTE explicito solo para el rol de la aplicacion, el
    // mismo criterio del resto de las funciones SECURITY DEFINER del proyecto. Es
    // lo unico que sentrycore_app gana con esta migracion: sigue SIN DELETE sobre
    // scan_photos y sobre event_photos.
    const FIRMAS = [
      'retencion_dias_efectivos(text, integer)',
      'retencion_tenants(integer)',
      'retencion_marcar_barrido(uuid)',
      'retencion_fotos_vencidas(uuid, text, integer, integer, uuid[])',
      'retencion_purgar_fotos(uuid, text, integer, uuid[])',
      'retencion_purgar_trazas(uuid, integer, integer)',
    ];
    for (const firma of FIRMAS) {
      await queryRunner.query(`REVOKE ALL ON FUNCTION ${firma} FROM PUBLIC`);
      await queryRunner.query(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'sentrycore_app') THEN
            GRANT EXECUTE ON FUNCTION ${firma} TO sentrycore_app;
          END IF;
        END
        $$
      `);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS retencion_purgar_trazas(uuid, integer, integer)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS retencion_purgar_fotos(uuid, text, integer, uuid[])`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS retencion_fotos_vencidas(uuid, text, integer, integer, uuid[])`,
    );
    await queryRunner.query(`DROP FUNCTION IF EXISTS retencion_marcar_barrido(uuid)`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS retencion_tenants(integer)`);
    await queryRunner.query(`DROP FUNCTION IF EXISTS retencion_dias_efectivos(text, integer)`);
    await queryRunner.query(`DROP INDEX IF EXISTS event_photos_retention_idx`);
    await queryRunner.query(`DROP INDEX IF EXISTS scan_photos_retention_idx`);
    await queryRunner.query(`DROP TABLE IF EXISTS retention_tenant_sweeps`);
    await queryRunner.query(`DROP TABLE IF EXISTS retention_purge_runs`);
  }
}
