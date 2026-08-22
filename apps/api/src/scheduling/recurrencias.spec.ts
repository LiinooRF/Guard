/**
 * Reglas recurrentes: "este guardia, este turno, estos dias".
 *
 * Lo que se prueba aca es el SQL de expansion, porque ahi vive toda la
 * decision: que reglas aplican a una fecha y cuales no. El resto —crear,
 * listar, dar de baja— es CRUD.
 */

import { SQL_EXPANDIR_RECURRENCIAS } from './recurrencias.sql';

describe('SQL de expansión de recurrencias', () => {
  it('es idempotente: correr la generación dos veces no duplica turnos', () => {
    // Se apoya en el UNIQUE (tenant_id, shift_id, guard_id, service_date) que
    // ya existia. Sin esto, apretar "generar" dos veces dejaba al guardia con
    // el turno repetido.
    expect(SQL_EXPANDIR_RECURRENCIAS).toContain('ON CONFLICT');
    expect(SQL_EXPANDIR_RECURRENCIAS).toContain('DO NOTHING');
  });

  it('respeta la decisión manual: no pisa una asignación ya cargada', () => {
    // Es el mismo ON CONFLICT, y es deliberado: si el supervisor movio o
    // cancelo el turno de un dia puntual, la regla no puede volver a ponerlo.
    expect(SQL_EXPANDIR_RECURRENCIAS).toMatch(/ON CONFLICT[\s\S]*DO NOTHING/);
  });

  it('solo expande reglas vigentes para esa fecha', () => {
    expect(SQL_EXPANDIR_RECURRENCIAS).toContain('r.starts_on <= $1::date');
    expect(SQL_EXPANDIR_RECURRENCIAS).toContain('r.ends_on IS NULL OR r.ends_on >= $1::date');
    expect(SQL_EXPANDIR_RECURRENCIAS).toContain('r.is_active');
  });

  /*
   * El detalle que mas facil se pasa por alto: el dia tiene que estar en la
   * regla Y en el turno. Una regla que incluya el domingo no puede inventar un
   * turno que no opera los domingos.
   */
  it('cruza los días de la regla con los del turno, no solo los de la regla', () => {
    const condiciones = SQL_EXPANDIR_RECURRENCIAS.match(/EXTRACT\(DOW FROM \$1::date\)/g) ?? [];
    expect(condiciones.length).toBe(2);
    expect(SQL_EXPANDIR_RECURRENCIAS).toContain('ANY (r.weekdays)');
    expect(SQL_EXPANDIR_RECURRENCIAS).toContain('ANY (s.weekdays)');
  });

  it('no expande turnos dados de baja', () => {
    expect(SQL_EXPANDIR_RECURRENCIAS).toContain('s.is_active');
  });

  it('respeta el alcance del supervisor y el filtro por recinto', () => {
    expect(SQL_EXPANDIR_RECURRENCIAS).toContain('supervisor_sites');
    expect(SQL_EXPANDIR_RECURRENCIAS).toContain('s.site_id = $2::uuid');
  });

  it('deja registrado de qué regla salió cada turno', () => {
    // Sin `recurrence_id` no se podria distinguir un turno puesto a mano de uno
    // que puso la regla, ni saber cuales retirar al darla de baja.
    expect(SQL_EXPANDIR_RECURRENCIAS).toContain('recurrence_id');
    expect(SQL_EXPANDIR_RECURRENCIAS).toContain('r.id');
  });
});
