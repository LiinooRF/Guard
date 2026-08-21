/**
 * Una ronda pendiente sale con la ruta de HOY, no con la de cuando se genero.
 *
 * EL CASO REAL (Janssen, 20-08-2026)
 * ---------------------------------------------------------------------------
 * El supervisor agrego un punto a la ruta y las rondas ya generadas siguieron
 * con la lista vieja. El guardia escaneaba la etiqueta del punto nuevo y el
 * servidor respondia "El punto escaneado no pertenece a esta ronda" (409), sin
 * ninguna forma de arreglarlo desde el panel: hubo que tocar la base a mano.
 *
 * La lista se congelaba al GENERAR la ronda. Ahora se congela al INICIARLA.
 *
 * POR QUE NO SE REFRESCA SIEMPRE
 * ---------------------------------------------------------------------------
 * Congelar tiene una razon valida: si a una ronda EN CURSO se le agrega un
 * punto a mitad de camino, el porcentaje de cumplimiento del guardia cambia
 * bajo sus pies y el informe deja de cuadrar. Por eso el refresco ocurre en el
 * unico momento en que es seguro: la transicion de 'pendiente' a 'en_curso'.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GuardService } from './guard.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';

function servicio(manager: { query: jest.Mock }) {
  const nada = () => ({}) as never;
  return new GuardService(
    { manager } as unknown as TenantContextService,
    nada(), nada(),
    nada(),
    { assertPatrolStartAllowed: jest.fn().mockResolvedValue(undefined) } as never,
    nada(),
  );
}

/** El SQL que ejecuta el inicio de ronda, tal como se le pasa al driver. */
function sqlDelInicio(manager: { query: jest.Mock }): string {
  const llamada = manager.query.mock.calls.find(([sql]) =>
    String(sql).includes("status = 'en_curso'"),
  );
  return llamada ? String(llamada[0]) : '';
}

describe('la ronda toma la ruta vigente al iniciar', () => {
  it('el inicio explícito relee los puntos de la ruta', async () => {
    const manager = { query: jest.fn().mockResolvedValue([{ id: 'p1', status: 'en_curso', started_at: new Date() }]) };
    await servicio(manager).startPatrol('p1', 'g1');

    const sql = sqlDelInicio(manager);
    expect(sql).toContain('route_checkpoints');
    expect(sql).toContain('expected_checkpoint_ids');
    // El orden importa: la ronda se recorre en la secuencia de la ruta.
    expect(sql).toMatch(/ORDER BY rc\.position/);
  });

  it('solo toca rondas pendientes: una en curso no cambia bajo los pies del guardia', async () => {
    const manager = { query: jest.fn().mockResolvedValue([{ id: 'p1', status: 'en_curso', started_at: new Date() }]) };
    await servicio(manager).startPatrol('p1', 'g1');
    expect(sqlDelInicio(manager)).toContain("status = 'pendiente'");
  });

  it('si la ruta se quedó sin puntos, conserva los que tenía', async () => {
    // Sin el COALESCE la ronda arrancaria con cero puntos esperados: imposible
    // de cumplir y sin manera de que el guardia lo note hasta el informe.
    const manager = { query: jest.fn().mockResolvedValue([{ id: 'p1', status: 'en_curso', started_at: new Date() }]) };
    await servicio(manager).startPatrol('p1', 'g1');
    const sql = sqlDelInicio(manager);
    expect(sql).toContain('COALESCE');
    expect(sql).toMatch(/COALESCE\([\s\S]*p\.expected_checkpoint_ids[\s\S]*\)/);
  });

  it('el arranque por escaneo hace el MISMO refresco que el botón', async () => {
    // Si solo se refrescara en el inicio explicito, el comportamiento
    // dependeria de por donde entro el guardia: el que escanea sin apretar
    // "iniciar" seguiria con la ruta vieja.
    const fuente = readFileSync(join(__dirname, 'guard.service.ts'), 'utf8');
    const refrescos = fuente.match(/expected_checkpoint_ids = COALESCE\(/g) ?? [];
    expect(refrescos.length).toBeGreaterThanOrEqual(2);
  });
});
