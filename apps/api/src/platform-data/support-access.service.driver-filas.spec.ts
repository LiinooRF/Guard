import { NotFoundException } from '@nestjs/common';
import type { DataSource } from 'typeorm';

import { SupportAccessService } from './support-access.service';

/**
 * Regresion de la forma que devuelve el driver: un UPDATE devuelve
 * **[filas, rowCount]**, no filas. `filas.length` media 2 siempre, asi que
 * cerrar una ventana ajena o inexistente respondia 200 con
 * `tenantId: undefined` — el cierre falso hace creer que ya nadie mira los
 * datos del cliente.
 */
const comoDriver = <T>(filas: T[]): [T[], number] => [filas, filas.length];

const ds = (query: jest.Mock) => ({ query }) as unknown as DataSource;
const SUPER = 'super-1';

describe('SupportAccessService.close — forma real del driver', () => {
  it('cerrar un acceso ajeno o inexistente es 404', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ '?column?': 1 }]) // assertSuperadmin (SELECT: plano)
      .mockResolvedValueOnce(comoDriver([])); // UPDATE sin filas
    await expect(new SupportAccessService(ds(query)).close(SUPER, 'acc-ajeno'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('cerrar la ventana propia responde el tenant que se dejo de mirar', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ '?column?': 1 }])
      .mockResolvedValueOnce(comoDriver([{ id: 'acc-1', tenant_id: 'tenant-1' }]));
    await expect(new SupportAccessService(ds(query)).close(SUPER, 'acc-1')).resolves.toEqual({
      supportAccessId: 'acc-1',
      tenantId: 'tenant-1',
      closed: true,
    });
  });
});
