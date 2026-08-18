import { NotFoundException } from '@nestjs/common';

import type { AuditService } from '../audit/audit.service';
import type { AuthService } from '../auth/auth.service';
import type { MailService } from '../auth/mail.service';
import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import { AdminService } from './admin.service';

/**
 * Regresion de la forma que devuelve el driver.
 *
 * `manager.query()` de un UPDATE o un DELETE devuelve **[filas, rowCount]**, no
 * filas. Los mocks de admin.service.spec.ts responden el arreglo plano —la forma
 * de un SELECT—, asi que confirmaban lo que el autor ya creia y ninguno de estos
 * casos fallaba. Aca el mock responde lo que responde PostgreSQL: leido como
 * arreglo, `.length` mide 2 SIEMPRE y `[0]` es el arreglo de filas, no una fila.
 */
const comoDriver = <T>(filas: T[]): [T[], number] => [filas, filas.length];

function servicio(query: jest.Mock, revokeAllSessions = jest.fn().mockResolvedValue(0)) {
  return {
    admin: new AdminService(
      { manager: { query } } as unknown as TenantContextService,
      { revokeAllSessions } as unknown as AuthService,
      {} as MailService,
      { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService,
    ),
    revokeAllSessions,
  };
}

describe('AdminService — UPDATE/DELETE leidos con la forma real del driver', () => {
  it('desactivar a alguien que no es administrable es 404, no un 200 silencioso', async () => {
    // Es el caso del ADMIN del tenant y el del id inventado: el UPDATE no toca
    // ninguna fila. Antes respondia 200 y ademas revocaba sesiones.
    const query = jest.fn().mockResolvedValueOnce(comoDriver([]));
    const { admin, revokeAllSessions } = servicio(query);

    await expect(admin.setUserActive('admin-1', false)).rejects.toBeInstanceOf(NotFoundException);
    expect(revokeAllSessions).not.toHaveBeenCalled();
  });

  it('desactivar a un usuario administrable si revoca sus sesiones', async () => {
    const query = jest.fn().mockResolvedValueOnce(comoDriver([{ id: 'user-1' }]));
    const revokeAllSessions = jest.fn().mockResolvedValue(2);
    const { admin } = servicio(query, revokeAllSessions);

    await expect(admin.setUserActive('user-1', false)).resolves.toEqual({
      id: 'user-1',
      isActive: false,
      revokedSessions: 2,
    });
  });

  it('editar un recinto inexistente es 404', async () => {
    const query = jest.fn().mockResolvedValueOnce(comoDriver([]));
    const { admin } = servicio(query);

    await expect(admin.updateSite('site-x', { name: 'Planta Sur' }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('activar o desactivar un recinto inexistente es 404', async () => {
    const query = jest.fn().mockResolvedValueOnce(comoDriver([]));
    const { admin } = servicio(query);

    await expect(admin.setSiteActive('site-x', false)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('editar un punto de control inexistente es 404', async () => {
    const query = jest.fn().mockResolvedValueOnce(comoDriver([]));
    const { admin } = servicio(query);

    await expect(admin.updateCheckpoint('cp-x', { name: 'Bodega' }))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('cambiar la exigencia de foto de un punto inexistente es 404', async () => {
    const query = jest.fn().mockResolvedValueOnce(comoDriver([]));
    const { admin } = servicio(query);

    await expect(admin.setCheckpointPhoto('cp-x', true)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('activar o desactivar un punto inexistente es 404', async () => {
    const query = jest.fn().mockResolvedValueOnce(comoDriver([]));
    const { admin } = servicio(query);

    await expect(admin.setCheckpointActive('cp-x', false))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('al reemplazar una etiqueta informa cual quedo retirada', async () => {
    // `replacedTagId` es la trazabilidad del recambio en terreno. Con la forma
    // real del driver salia null aunque el UPDATE si hubiera retirado una.
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'cp-1' }]) // ensureCheckpoint (SELECT: plano)
      .mockResolvedValueOnce(comoDriver([{ id: 'tag-viejo' }])) // UPDATE tags
      .mockResolvedValueOnce([]); // INSERT de la etiqueta nueva
    const { admin } = servicio(query);

    await expect(admin.registerTag('cp-1', { uid: '04AABBCC' }))
      .resolves.toMatchObject({ replacedTagId: 'tag-viejo' });
  });

  it('sin etiqueta previa el reemplazo queda en null, no inventa una', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ id: 'cp-1' }])
      .mockResolvedValueOnce(comoDriver([]))
      .mockResolvedValueOnce([]);
    const { admin } = servicio(query);

    await expect(admin.registerTag('cp-1', { uid: '04AABBCC' }))
      .resolves.toMatchObject({ replacedTagId: null });
  });

  it('retirar una etiqueta ya inactiva o inexistente es 404', async () => {
    const query = jest.fn().mockResolvedValueOnce(comoDriver([]));
    const { admin } = servicio(query);

    await expect(admin.retireTag('tag-x')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('retirar una etiqueta activa responde que quedo inactiva', async () => {
    const query = jest.fn().mockResolvedValueOnce(comoDriver([{ id: 'tag-1' }]));
    const { admin } = servicio(query);

    await expect(admin.retireTag('tag-1')).resolves.toEqual({ id: 'tag-1', active: false });
  });
});
