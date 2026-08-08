import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Que la renovación de sesión siga MONTADA.
 *
 * `useSessionRefresh` existía, estaba bien escrito y no lo llamaba nadie. La
 * consecuencia no se ve en ningún test de unidad: el token vence a los 15
 * minutos y al usuario lo echan al login. A un guardia en un turno de 12 horas
 * le pasa decenas de veces, y en un subterráneo no puede volver a entrar.
 *
 * Se comprobó en un teléfono real, inspeccionando el WebView: la app quedó en
 * `/app/guardia`, estuvo minutos quieta, y terminó sola en el login.
 *
 * Este test es barato y burdo —lee el archivo— pero cubre justo lo que se
 * rompió: que alguien borre el montaje sin darse cuenta de para qué estaba.
 */
const AQUI = __dirname;

describe('renovacion de sesion', () => {
  it('el shell de los paneles monta SesionViva', () => {
    const shell = readFileSync(join(AQUI, 'dashboard-shell.tsx'), 'utf8');
    expect(shell).toContain('<SesionViva />');
    expect(shell).toContain("from './sesion-viva'");
  });

  it('SesionViva usa el hook y no una copia de su logica', () => {
    // Si alguien reimplementa la renovacion aca, se pierde el candado entre
    // pestañas y dos de ellas rotan el token a la vez: la segunda invalida a la
    // primera y ambas caen al login.
    const componente = readFileSync(join(AQUI, 'sesion-viva.tsx'), 'utf8');
    expect(componente).toContain('useSessionRefresh');
    expect(componente).toContain("'use client'");
  });
});
