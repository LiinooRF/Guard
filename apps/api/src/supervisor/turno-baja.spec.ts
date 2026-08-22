/**
 * Retirar un turno del calendario.
 *
 * Pedido desde terreno: "poder eliminar los turnos". Se implementa como BAJA y
 * no como borrado, por la misma razon que en rutas y recurrencias: un turno
 * tiene asignaciones, y esas tienen rondas con escaneos, fotos e informes.
 * Borrarlo dejaria ese historial sin dueño y un informe de marzo no podria
 * decir a que turno pertenecio cada ronda.
 *
 * Lo que el supervisor quiere —que deje de generar rondas y desaparezca de las
 * listas— lo da la baja igual.
 */

import { NotFoundException } from '@nestjs/common';

import type { AuditService } from '../audit/audit.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { RulesService } from '../rules/rules.service';
import { SupervisorService } from './supervisor.service';

function servicio(query: jest.Mock, record = jest.fn().mockResolvedValue(undefined)) {
  const s = new SupervisorService(
    { manager: { query } } as unknown as TenantContextService,
    {} as unknown as RulesService,
    { record } as unknown as AuditService,
  );
  return { s, record };
}

const TURNO = { id: 'shift-1', name: 'Noche', site_id: 'site-1' };

describe('dar de baja un turno', () => {
  it('lo marca inactivo y solo dentro de los recintos del supervisor', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([TURNO])          // UPDATE ... RETURNING
      .mockResolvedValueOnce([{ total: '0' }]) // asignaciones futuras
      .mockResolvedValueOnce([{ label: 'Ana Supervisora' }]);
    const { s } = servicio(query);

    await expect(s.cambiarActivoTurno('shift-1', 'sup-1', false)).resolves.toMatchObject({
      id: 'shift-1', isActive: false,
    });

    const [sql, params] = query.mock.calls[0]!;
    expect(String(sql)).toContain('UPDATE shifts');
    expect(String(sql)).toContain('supervisor_sites');
    expect(params).toEqual(['shift-1', false, 'sup-1']);
  });

  it('un turno de otro recinto no se puede tocar', async () => {
    // El UPDATE no devuelve filas porque el EXISTS del alcance no da.
    const { s } = servicio(jest.fn().mockResolvedValueOnce([]));
    await expect(s.cambiarActivoTurno('ajeno', 'sup-1', false)).rejects.toThrow(NotFoundException);
  });

  /*
   * Dar de baja NO vacia el calendario: las asignaciones ya creadas siguen ahi
   * y pueden estar trabajandose hoy. Se informan para que el supervisor no crea
   * que desaparecieron.
   */
  it('avisa cuántas asignaciones futuras quedan en pie', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([TURNO])
      .mockResolvedValueOnce([{ total: '7' }])
      .mockResolvedValueOnce([{ label: 'Ana' }]);
    const { s } = servicio(query);

    await expect(s.cambiarActivoTurno('shift-1', 'sup-1', false)).resolves.toMatchObject({
      pendingAssignments: 7,
    });
    expect(String(query.mock.calls[1]![0])).toContain('service_date >= CURRENT_DATE');
  });

  it('queda auditado con el nombre del turno', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([TURNO])
      .mockResolvedValueOnce([{ total: '0' }])
      .mockResolvedValueOnce([{ label: 'Ana Supervisora' }]);
    const { s, record } = servicio(query);

    await s.cambiarActivoTurno('shift-1', 'sup-1', false);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'turno.dado_de_baja',
      entityType: 'shift',
      entityId: 'shift-1',
      summary: expect.stringContaining('Noche'),
    }));
  });

  it('se puede reactivar', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([TURNO])
      .mockResolvedValueOnce([{ total: '0' }])
      .mockResolvedValueOnce([{ label: 'Ana' }]);
    const { s, record } = servicio(query);

    await expect(s.cambiarActivoTurno('shift-1', 'sup-1', true)).resolves.toMatchObject({
      isActive: true,
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'turno.reactivado' }));
  });
});
