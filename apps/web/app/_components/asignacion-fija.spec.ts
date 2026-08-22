/**
 * La asignación fija, en la pantalla.
 *
 * La funcionalidad existía solo por API: el calendario seguía mandando día por
 * día y cada semana había que rehacer el mismo trabajo. Sin pantalla, una
 * función que nadie puede usar es una función que no existe.
 *
 * Se prueba leyendo el archivo, igual que `visual-system.spec.ts`: este paquete
 * corre en `node` a propósito y lo que hay que impedir son regresiones de
 * contrato y de vocabulario, no de pintado.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const panel = readFileSync(join(__dirname, 'supervisor-schedule.tsx'), 'utf8');
const css = readFileSync(join(__dirname, '..', 'globals.css'), 'utf8');

describe('asignación fija en el panel de turnos', () => {
  it('llama a los endpoints de recurrencia, no al de asignación por fecha', () => {
    expect(panel).toContain('/recurrences');
    expect(panel).toMatch(/method: 'POST'[\s\S]{0,200}weekdays/);
  });

  it('manda los días como números y la fecha de inicio', () => {
    expect(panel).toContain("form.getAll('recWeekday').map(Number)");
    expect(panel).toContain('startsOn');
  });

  it('la fecha de término es opcional: un turno fijo no la necesita', () => {
    expect(panel).toMatch(/form\.get\('recEndsOn'\)\s*\?\s*\{ endsOn/);
  });

  it('no deja crear una regla sin días marcados', () => {
    expect(panel).toContain('Marca al menos un día.');
  });

  /*
   * Lo que mas confunde de dar de baja: creer que se borran los turnos ya
   * programados. El mensaje lo dice antes de que alguien lo descubra solo.
   */
  it('al dar de baja una regla, avisa que los turnos ya creados siguen', () => {
    expect(panel).toContain('Los turnos ya programados siguen en el calendario.');
  });

  it('lista las reglas vigentes con su guardia y sus días', () => {
    expect(panel).toContain('Asignaciones fijas de este turno');
    expect(panel).toContain('assignmentsCreated');
    expect(panel).toContain('todos los días');
  });

  it('el paso 3 no reemplaza al 2: se explica para qué sirve cada uno', () => {
    expect(panel).toContain('3. Asignación fija (opcional)');
    expect(panel).toMatch(/El paso 2 sigue sirviendo para una semana puntual/);
  });
});

describe('retirar turnos desde el panel', () => {
  it('usa la baja y no un borrado', () => {
    expect(panel).toMatch(/shifts\/\$\{shiftId\}\/active/);
    expect(panel).toContain("isActive: false");
    expect(panel).not.toMatch(/method: 'DELETE'[\s\S]{0,120}shifts/);
  });

  it('dice cuántas asignaciones quedan en pie tras retirar', () => {
    expect(panel).toContain('pendingAssignments');
    expect(panel).toMatch(/Quedan \$\{r\.pendingAssignments\} asignación/);
  });

  it('explica que el historial no se toca', () => {
    expect(panel).toMatch(/Los turnos ya programados siguen en el\s+calendario y el historial no se toca\./);
  });

  it('las listas nuevas tienen estilo propio', () => {
    expect(css).toMatch(/\.schedule-turnos-vigentes, \.schedule-reglas \{/);
    expect(css).toMatch(/\.schedule-nota \{/);
  });
});
