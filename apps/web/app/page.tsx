import {
  DEFAULT_FEATURE_FLAGS,
  DEFAULT_PATROL_RULES,
  ROLE_PLATFORMS,
  ROLES,
} from '@voxia/shared';

/**
 * Pagina de arranque del scaffolding.
 *
 * Existe para dos cosas: probar que `@voxia/shared` se resuelve desde la web
 * igual que desde la API, y dejar a la vista del equipo el modelo de roles y los
 * defaults de las reglas. Se reemplaza en cuanto exista el login (issue #1).
 */
export default function Home() {
  const alcance: Record<string, string> = {
    SUPERADMIN: 'Cruza tenants: empresas, licencias, white-label',
    ADMIN: 'Su empresa: usuarios, recintos, reglas, macro-estadisticas',
    SUPERVISOR: 'Sus recintos asignados: rutas, turnos, monitoreo',
    GUARDIA: 'Solo su ronda del turno',
  };

  return (
    <main>
      <p className="muted" style={{ margin: 0, fontSize: '0.85rem', letterSpacing: '0.08em' }}>
        SCAFFOLDING · v0.1.0
      </p>
      <h1 style={{ margin: '0.25rem 0 0.5rem' }}>VoxIA Control</h1>
      <p className="muted" style={{ fontSize: '1.05rem', marginTop: 0 }}>
        Monitoreo de rondas de vigilancia con etiquetas NFC. SaaS multi-tenant white-label.
      </p>

      <div className="card">
        <strong>El monorepo esta conectado.</strong>
        <p className="muted" style={{ marginBottom: 0 }}>
          Los datos de abajo vienen de <code>@voxia/shared</code>, el mismo paquete que consume la
          API y la app movil. Si se ven, el contrato compartido funciona.
        </p>
      </div>

      <h2>Roles y plataforma</h2>
      <p className="muted">
        Rol y plataforma son ejes separados: el rol define permisos, la plataforma es consecuencia
        de la tarea. <code>GUARDIA</code> es el unico sin acceso desktop.
      </p>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Rol</th>
              <th>Entra desde</th>
              <th>Alcance</th>
            </tr>
          </thead>
          <tbody>
            {ROLES.map((role) => (
              <tr key={role}>
                <td>
                  <code>{role}</code>
                </td>
                <td>{ROLE_PLATFORMS[role].join(' + ')}</td>
                <td className="muted">{alcance[role]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Reglas por defecto</h2>
      <p className="muted">
        Un tenant nuevo opera con estos valores sin configurar nada. El admin puede cambiar
        cualquiera sin necesidad de un deploy ni de actualizar la app (issue #16).
      </p>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Parametro</th>
              <th>Default</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(DEFAULT_PATROL_RULES).map(([k, v]) => (
              <tr key={k}>
                <td>
                  <code>{k}</code>
                </td>
                <td>{String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>Modulos</h2>
      <p className="muted">
        Se prenden y apagan por tenant o por plan de licencia. Es lo que permite vender planes
        distintos sin mantener versiones distintas del producto.
      </p>
      <div className="scroll-x">
        <table>
          <thead>
            <tr>
              <th>Modulo</th>
              <th>Por defecto</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(DEFAULT_FEATURE_FLAGS).map(([k, v]) => (
              <tr key={k}>
                <td>
                  <code>{k}</code>
                </td>
                <td style={{ color: v ? 'var(--accent)' : 'var(--muted)' }}>
                  {v ? 'activo' : 'apagado'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="muted" style={{ fontSize: '0.9rem' }}>
        Siguiente paso: issue <strong>#6</strong> (infraestructura) y <strong>#7</strong> (modelo de
        datos con RLS). Todo lo demas depende de esos dos.
      </p>
    </main>
  );
}
