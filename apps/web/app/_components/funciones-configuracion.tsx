/**
 * Carga de la pantalla de funciones del sistema (#102). Server Component: pide
 * el catalogo y la vista de administracion de modulos y de reglas con la cookie
 * HttpOnly de la sesion, y entrega todo pintado al componente interactivo.
 *
 * Se engancha con UNA linea en app/app/[role]/page.tsx, solo para ADMIN (ver
 * INTEGRACION.md). Que solo el ADMIN la vea es comodidad de navegacion: los
 * endpoints exigen `tenant:rules:manage` y `tenant:audit:read` en el servidor, y
 * el guard global deniega por defecto.
 *
 * Mismo patron que `reglas-configuracion.tsx`, a proposito: la cookie de acceso
 * es HttpOnly y viaja reenviada a mano por la red interna, nunca leida desde el
 * navegador.
 */
import { cookies } from 'next/headers';

import { FuncionesPanel } from './funciones-panel';
import type { VistaModulos } from './funciones-modelo';
import type { CatalogoReglas, VistaReglas } from './reglas-catalogo';

export async function FuncionesConfiguracion({ apiUrl }: { apiUrl?: string } = {}) {
  const publica = apiUrl ?? process.env.NEXT_PUBLIC_API_URL ?? '/api';

  // GET /features/admin ya trae las fichas de los modulos y las etiquetas de
  // nivel, asi que no hace falta pedir tambien /features/catalog.
  const [catalogoReglas, vistaReglas, vistaModulos] = await Promise.all([
    pedir<CatalogoReglas | null>('/rules/catalog', null),
    pedir<VistaReglas | null>('/rules/admin', null),
    pedir<VistaModulos | null>('/features/admin', null),
  ]);

  // Sin catalogo de reglas o sin la vista de la empresa no hay pantalla que
  // generar: se dice, en vez de inventar un formulario vacio que parezca
  // configuracion real. Los modulos si pueden faltar solos: el panel muestra el
  // resto igual.
  if (!catalogoReglas || !vistaReglas) {
    return (
      <section className="management-card management-wide reglas-panel" id="funciones">
        <div className="card-heading">
          <div>
            <span className="eyebrow">Funciones del sistema</span>
            <h2>Configuración de las funciones</h2>
          </div>
        </div>
        <div className="dashboard-empty">
          <strong>No pudimos leer la configuración</strong>
          <span>
            Vuelve a cargar la página. Si sigue igual, tu cuenta puede no tener permiso para
            configurar las funciones de la empresa.
          </span>
        </div>
      </section>
    );
  }

  return (
    <FuncionesPanel
      catalogoReglas={catalogoReglas}
      vistaReglasInicial={vistaReglas}
      vistaModulosInicial={vistaModulos}
      apiUrl={publica}
    />
  );
}

/** GET autenticado desde el servidor, reenviando la cookie de acceso. */
async function pedir<T>(ruta: string, alternativa: T): Promise<T> {
  const galleta = (await cookies()).get('voxia_access');
  if (!galleta) return alternativa;

  const interna = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? '/api';
  try {
    const respuesta = await fetch(`${interna}${ruta}`, {
      headers: { cookie: `voxia_access=${galleta.value}` },
      cache: 'no-store',
    });
    if (!respuesta.ok) return alternativa;
    return (await respuesta.json()) as T;
  } catch {
    return alternativa;
  }
}
