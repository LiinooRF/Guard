/**
 * Carga de la pantalla de reglas configurables (#83). Server Component: pide la
 * vista del nivel empresa, el catalogo y los recintos con la cookie HttpOnly de
 * la sesion, y entrega todo pintado al componente interactivo.
 *
 * Se engancha con una linea en app/app/[role]/page.tsx, solo para ADMIN.
 */
import { cookies } from 'next/headers';

import { ReglasPanel, type RecintoParaReglas } from './reglas-panel';
import type { CatalogoReglas, VistaReglas } from './reglas-catalogo';

export async function ReglasConfiguracion({ apiUrl }: { apiUrl?: string } = {}) {
  const publica = apiUrl ?? process.env.NEXT_PUBLIC_API_URL ?? '/api';

  const [catalogo, vista, recintos] = await Promise.all([
    pedir<CatalogoReglas | null>('/rules/catalog', null),
    pedir<VistaReglas | null>('/rules/admin', null),
    pedir<RecintoParaReglas[]>('/admin/sites', []),
  ]);

  // Sin catalogo o sin vista no hay formulario que generar: se dice, no se
  // inventa una pantalla vacia que parezca configuracion real.
  if (!catalogo || !vista) {
    return (
      <section className="management-card management-wide reglas-panel" id="reglas">
        <div className="card-heading">
          <div>
            <span className="eyebrow">Configuración</span>
            <h2>Reglas de operación</h2>
          </div>
        </div>
        <div className="dashboard-empty">
          <strong>No pudimos leer la configuración</strong>
          <span>
            Vuelve a cargar la página. Si sigue igual, tu cuenta puede no tener permiso para
            configurar las reglas de la empresa.
          </span>
        </div>
      </section>
    );
  }

  return (
    <ReglasPanel
      catalogo={catalogo}
      vistaInicial={vista}
      recintos={recintos}
      apiUrl={publica}
    />
  );
}

/**
 * GET autenticado desde el servidor. La cookie de acceso es HttpOnly: viaja
 * reenviada a mano por la red interna, nunca leida desde el navegador.
 */
async function pedir<T>(ruta: string, alternativa: T): Promise<T> {
  const galleta = (await cookies()).get('sentrycore_access');
  if (!galleta) return alternativa;

  const interna = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? '/api';
  try {
    const respuesta = await fetch(`${interna}${ruta}`, {
      headers: { cookie: `sentrycore_access=${galleta.value}` },
      cache: 'no-store',
    });
    if (!respuesta.ok) return alternativa;
    return (await respuesta.json()) as T;
  } catch {
    return alternativa;
  }
}
