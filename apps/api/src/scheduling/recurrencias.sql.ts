/**
 * Expansion de reglas recurrentes a asignaciones concretas.
 *
 * La regla dice "este guardia, este turno, los martes". La asignacion dice
 * "este guardia, este turno, el martes 26 de agosto". Esto convierte lo primero
 * en lo segundo, para UNA fecha.
 *
 * ES IDEMPOTENTE, y eso no es un lujo: la generacion de rondas puede correrse
 * dos veces el mismo dia —a mano, reintentando, o porque el supervisor aprieta
 * dos veces— y no puede duplicar turnos. El `ON CONFLICT DO NOTHING` se apoya
 * en el UNIQUE (tenant_id, shift_id, guard_id, service_date) que ya existia.
 *
 * Ese mismo conflicto es lo que respeta las EXCEPCIONES: si el supervisor ya
 * cargo o cancelo a mano la asignacion de ese dia, la regla no la pisa. La
 * decision manual gana siempre sobre la automatica.
 */
export const SQL_EXPANDIR_RECURRENCIAS = `
  INSERT INTO shift_assignments (tenant_id, shift_id, guard_id, service_date, recurrence_id)
  SELECT r.tenant_id, r.shift_id, r.guard_id, $1::date, r.id
  FROM shift_recurrences r
  JOIN shifts s ON s.tenant_id = r.tenant_id AND s.id = r.shift_id
  WHERE r.is_active
    AND s.is_active
    AND r.starts_on <= $1::date
    AND (r.ends_on IS NULL OR r.ends_on >= $1::date)
    -- El dia de la semana tiene que estar en la regla Y en el turno: si el
    -- turno no opera los domingos, una regla que los incluya no puede inventar
    -- un turno que no existe.
    AND EXTRACT(DOW FROM $1::date)::smallint = ANY (r.weekdays)
    AND EXTRACT(DOW FROM $1::date)::smallint = ANY (s.weekdays)
    AND ($2::uuid IS NULL OR s.site_id = $2::uuid)
    AND ($3::uuid IS NULL OR EXISTS (
          SELECT 1 FROM supervisor_sites ss
          WHERE ss.site_id = s.site_id AND ss.supervisor_id = $3::uuid))
  ON CONFLICT (tenant_id, shift_id, guard_id, service_date) DO NOTHING
  RETURNING id, shift_id, guard_id
`;
