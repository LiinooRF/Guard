/**
 * Ronda y turno no son lo mismo, y al guardia no se le pueden mezclar.
 *
 * Reportado desde terreno: al cerrar una ronda, la pantalla decia "Novedades
 * del turno" y "No registraste novedades en este turno". El guardia leia que
 * habia terminado su JORNADA cuando solo habia cerrado una de las varias rondas
 * que tiene por turno.
 *
 * El turno es la jornada —un horario, un guardia, un dia—. La ronda es cada
 * recorrido dentro de ese turno; un turno de ocho horas puede tener cuatro. Un
 * texto que las confunde hace que alguien se vaya a su casa antes de tiempo.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const resumen = readFileSync(join(__dirname, 'guard-shift-summary.tsx'), 'utf8');
const ronda = readFileSync(join(__dirname, 'guard-shift.tsx'), 'utf8');

/** Texto entre etiquetas: lo que el guardia realmente lee en pantalla. */
function textoVisible(fuente: string): string[] {
  return (fuente.match(/>[^<>{}]*[a-záéíóúñ]{3,}[^<>{}]*</gi) ?? []).map((t) => t.slice(1, -1).trim());
}

describe('vocabulario de la pantalla del guardia', () => {
  it('el resumen de cierre habla de la RONDA, no del turno', () => {
    // Esta pantalla recibe `patrolId`: lo que resume es una ronda.
    const conTurno = textoVisible(resumen).filter((t) => /turno/i.test(t));
    expect(conTurno).toEqual([]);
  });

  it('y nombra la ronda explícitamente', () => {
    expect(resumen).toContain('Novedades de la ronda');
    expect(resumen).toContain('No registraste novedades en esta ronda.');
  });

  it('sin ronda asignada, el título y el texto dicen lo mismo', () => {
    // Antes el titulo decia "No tienes un turno asignado" y abajo "Cuando te
    // asignen una ronda...": dos nombres para lo mismo, en la misma pantalla.
    expect(ronda).toContain('No tienes una ronda asignada');
    expect(ronda).not.toContain('No tienes un turno asignado');
  });
});
