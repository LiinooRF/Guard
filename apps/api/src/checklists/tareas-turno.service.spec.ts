import { ForbiddenException, NotFoundException } from '@nestjs/common';

import type { TenantContextService } from '../database/tenant-context/tenant-context.service';
import type { SupervisorService } from '../supervisor/supervisor.service';
import type { ChecklistsService } from './checklists.service';
import { TareasTurnoService } from './tareas-turno.service';

/**
 * El alcance del SUPERVISOR en el editor de tareas (#265).
 *
 * El rol NO basta: `checklists:manage` dice que puede armar tareas, no en que
 * recintos. Eso lo decide `supervisor_sites`, y estas pruebas son las unicas que
 * miran esa segunda puerta — la matriz de autorizacion solo ve la primera.
 */
function servicio(
  query: jest.Mock,
  opciones: { asignado?: boolean } = {},
) {
  const ensureAssignedSite = jest.fn().mockImplementation(async () => {
    // Copia fiel de SupervisorService.ensureAssignedSite: 403 si el recinto no
    // esta en supervisor_sites. Un mock que siempre resuelva convertiria estas
    // pruebas en decoracion.
    if (opciones.asignado === false) {
      throw new ForbiddenException('No tienes este recinto asignado');
    }
  });
  const checklists = {
    listTemplates: jest.fn().mockResolvedValue([]),
    createTemplate: jest.fn().mockResolvedValue({ id: 'tpl-nueva' }),
    getTemplate: jest.fn().mockResolvedValue({ id: 'tpl-1' }),
    updateTemplate: jest.fn().mockResolvedValue({ id: 'tpl-1' }),
    setTemplateActive: jest.fn().mockResolvedValue({ id: 'tpl-1', isActive: false }),
  };
  const service = new TareasTurnoService(
    { manager: { query } } as unknown as TenantContextService,
    checklists as unknown as ChecklistsService,
    { ensureAssignedSite } as unknown as SupervisorService,
  );
  return { service, checklists, ensureAssignedSite };
}

describe('TareasTurnoService — el supervisor solo llega a sus recintos (#265)', () => {
  it('una plantilla de un recinto que no es suyo es 403, no 404', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ site_id: 'recinto-ajeno' }]);
    const { service, checklists } = servicio(query, { asignado: false });

    await expect(service.getTemplate('tpl-ajena', 'sup-1')).rejects.toThrow(ForbiddenException);
    // Y no se alcanzo a leer nada de la plantilla ajena.
    expect(checklists.getTemplate).not.toHaveBeenCalled();
  });

  it('editar una plantilla de un recinto ajeno tampoco pasa', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ site_id: 'recinto-ajeno' }]);
    const { service, checklists } = servicio(query, { asignado: false });

    await expect(
      service.updateTemplate('tpl-ajena', 'sup-1', { name: 'Mi nombre' }),
    ).rejects.toThrow(ForbiddenException);
    expect(checklists.updateTemplate).not.toHaveBeenCalled();
  });

  it('desactivar una plantilla de un recinto ajeno tampoco pasa', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ site_id: 'recinto-ajeno' }]);
    const { service, checklists } = servicio(query, { asignado: false });

    await expect(service.setTemplateActive('tpl-ajena', 'sup-1', false)).rejects.toThrow(
      ForbiddenException,
    );
    expect(checklists.setTemplateActive).not.toHaveBeenCalled();
  });

  it('listar las plantillas de un recinto ajeno no devuelve ni los nombres', async () => {
    const query = jest.fn();
    const { service, checklists } = servicio(query, { asignado: false });

    await expect(service.listTemplates('recinto-ajeno', 'sup-1')).rejects.toThrow(
      ForbiddenException,
    );
    expect(checklists.listTemplates).not.toHaveBeenCalled();
  });

  it('crear en un recinto ajeno se corta antes de escribir', async () => {
    const query = jest.fn();
    const { service, checklists } = servicio(query, { asignado: false });

    await expect(
      service.createTemplate('recinto-ajeno', 'sup-1', {
        name: 'Tareas del turno',
        items: [{ label: 'Fotografiar el refrigerador', responseType: 'ok_falla' }],
      }),
    ).rejects.toThrow(ForbiddenException);
    expect(checklists.createTemplate).not.toHaveBeenCalled();
  });

  /**
   * La plantilla de otra EMPRESA no la ve la consulta: RLS la filtra antes, asi
   * que llegan cero filas. Que eso termine en 404 y no en 500 es parte del
   * contrato — y que sea 404 y no 403 tambien: un 403 le confirmaria a quien
   * prueba ids que ese id existe en alguna parte.
   */
  it('una plantilla de otra empresa es 404: RLS la filtra y no llega ninguna fila', async () => {
    const query = jest.fn().mockResolvedValueOnce([]);
    const { service, ensureAssignedSite } = servicio(query);

    await expect(service.getTemplate('tpl-de-otro-tenant', 'sup-1')).rejects.toThrow(
      NotFoundException,
    );
    expect(ensureAssignedSite).not.toHaveBeenCalled();
  });

  /**
   * Una plantilla de alcance empresa cubre TODOS los recintos del tenant,
   * incluidos los que este supervisor no tiene. Y su hora local no tiene zona
   * con la que resolverse. Es del ADMIN.
   */
  it('la plantilla de toda la empresa no la toca el supervisor ni en su propio recinto', async () => {
    const query = jest.fn().mockResolvedValueOnce([{ site_id: null }]);
    const { service, checklists } = servicio(query);

    await expect(service.updateTemplate('tpl-empresa', 'sup-1', { name: 'Otro' })).rejects.toThrow(
      ForbiddenException,
    );
    expect(checklists.updateTemplate).not.toHaveBeenCalled();
  });

  it('con el recinto asignado, la plantilla se lee y se edita', async () => {
    const query = jest.fn().mockResolvedValue([{ site_id: 'recinto-propio' }]);
    const { service, checklists, ensureAssignedSite } = servicio(query);

    await expect(service.getTemplate('tpl-1', 'sup-1')).resolves.toEqual({ id: 'tpl-1' });
    expect(ensureAssignedSite).toHaveBeenCalledWith('recinto-propio', 'sup-1');
    expect(checklists.getTemplate).toHaveBeenCalledWith('tpl-1');
  });
});

describe('TareasTurnoService — el recinto sale de la URL, no del cuerpo (#265)', () => {
  /**
   * El caso que el DTO cierra y esta prueba vigila: pedir sobre el recinto
   * propio y colar otro en el cuerpo. Si algun dia alguien agrega `siteId` a
   * `CrearTareasTurnoDto`, esta prueba sigue pasando pero el DTO deja entrar el
   * campo — por eso el cuerpo de aca lleva el recinto ajeno adentro a proposito.
   */
  it('un recinto colado en el cuerpo no le gana al de la URL ya comprobada', async () => {
    const query = jest.fn();
    const { service, checklists, ensureAssignedSite } = servicio(query);

    await service.createTemplate('recinto-propio', 'sup-1', {
      name: 'Tareas del turno',
      items: [{ label: 'Fotografiar el refrigerador', responseType: 'ok_falla' }],
      // @ts-expect-error el DTO no declara siteId; se manda igual para probar
      // que el servicio no lo propaga aunque llegue por otra via.
      siteId: 'recinto-ajeno',
    });

    expect(ensureAssignedSite).toHaveBeenCalledWith('recinto-propio', 'sup-1');
    expect(checklists.createTemplate).toHaveBeenCalledWith(
      expect.objectContaining({ siteId: 'recinto-propio' }),
    );
  });

  it('sin turno no manda shiftId: `undefined` explicito lo trataria como "cualquier turno" igual, pero ensucia el alcance', async () => {
    const query = jest.fn();
    const { service, checklists } = servicio(query);

    await service.createTemplate('recinto-propio', 'sup-1', {
      name: 'Tareas del turno',
      items: [{ label: 'Extintor', responseType: 'ok_falla' }],
    });

    const enviado = checklists.createTemplate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(enviado)).not.toContain('shiftId');
  });
});

describe('TareasTurnoService — catalogo del formulario (#265)', () => {
  it('trae la ZONA HORARIA del recinto, que es lo que le da sentido a la hora de la tarea', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        id: 'site-1',
        name: 'Planta Sur',
        branch_name: 'Sucursal Maipú',
        timezone: 'America/Santiago',
        checkpoints: [{ id: 'punto-cocina', name: 'Cocina' }],
        shifts: [{ id: 'turno-1', name: 'Noche', startsAt: '22:00', endsAt: '06:00' }],
      },
    ]);
    const { service } = servicio(query);

    const catalogo = await service.catalogo('sup-1');

    expect(catalogo[0]).toEqual({
      id: 'site-1',
      name: 'Planta Sur',
      branchName: 'Sucursal Maipú',
      timezone: 'America/Santiago',
      checkpoints: [{ id: 'punto-cocina', name: 'Cocina' }],
      shifts: [{ id: 'turno-1', name: 'Noche', startsAt: '22:00', endsAt: '06:00' }],
    });

    const [sql, parametros] = query.mock.calls[0] as [string, unknown[]];
    // El filtro es el JOIN con supervisor_sites, no un WHERE sobre sites: sin el
    // el catalogo enumeraria los recintos de toda la empresa.
    expect(sql).toContain('JOIN sites s ON s.tenant_id = ss.tenant_id');
    expect(sql).toContain('ss.supervisor_id = $1');
    expect(sql).toContain('s.timezone');
    expect(parametros).toEqual(['sup-1']);
  });
});
