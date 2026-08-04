/**
 * Filtro de recintos visibles, compartido por las graficas (#89) y la
 * exportacion a Excel (#136).
 *
 * Vive en un modulo puro —sin Nest, sin base— por la misma razon que
 * `stats-range.ts`: es un CONTROL DE ACCESO y no puede existir dos veces. Nacio
 * duplicado literalmente en `stats-charts.service.ts` y en
 * `excel-export.service.ts`; el dia que alguien corrija el criterio en un lado
 * (agregar `ss.tenant_id`, cambiar como se resuelve la asignacion) el otro
 * queda con la version vieja y nadie se entera hasta que un supervisor ve un
 * recinto ajeno en su planilla.
 *
 * RLS ya encierra la consulta en el tenant; esto es la capa de ENCIMA: el
 * SUPERVISOR solo ve los recintos que tiene asignados, y eso no se deduce de su
 * rol —el rol solo dice que la restriccion existe—, hay que cruzarlo contra
 * `supervisor_sites` en cada consulta.
 *
 * El `tenant_id` NUNCA viaja como parametro desde el cliente: lo pone el
 * interceptor con `set_config('app.tenant_id', ..., true)` y lo aplica la
 * politica RLS. Un `tenant_id` de query string seria una IDOR con nombre nuevo.
 */

/**
 * Posiciones que este fragmento OCUPA en la lista de parametros. Es la parte
 * incomoda de compartir texto SQL con parametros posicionales: quien lo
 * interpole tiene que ligar exactamente estos tres, en este orden, antes de sus
 * propios parametros.
 *
 * Documentado aca y verificado en los tests de los dos llamadores, porque un
 * corrimiento silencioso de `$3` convertiria el filtro del supervisor en un
 * filtro por otra cosa — y seguiria devolviendo filas.
 */
export const PARAMETROS_FILTRO_RECINTOS = Object.freeze({
  /** `$3` — id del SUPERVISOR, o NULL para apagar el filtro (ADMIN). */
  supervisorId: 3,
  /** `$4` — recinto pedido explicitamente, o NULL. */
  siteId: 4,
  /** `$5` — sucursal pedida explicitamente, o NULL. */
  branchName: 5,
} as const);

/**
 * Se aplica sobre el alias `s` de `sites`. Empieza con `AND`, asi que se
 * interpola despues de un `WHERE` que ya tenga al menos una condicion (o de un
 * `WHERE TRUE`).
 */
export const FILTRO_RECINTOS = `
        AND ($3::uuid IS NULL OR EXISTS (
              SELECT 1 FROM supervisor_sites ss
              WHERE ss.site_id = s.id AND ss.supervisor_id = $3::uuid))
        AND ($4::uuid IS NULL OR s.id = $4::uuid)
        AND ($5::text IS NULL OR s.branch_name = $5::text)`;
