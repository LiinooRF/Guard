/**
 * Carga de las pantallas de consentimiento (#78). Server Components: piden los
 * datos con la cookie HttpOnly de la sesion y entregan todo pintado a los
 * componentes interactivos, igual que `reglas-configuracion.tsx`.
 *
 * Son las dos lineas que faltaban en `app/app/[role]/page.tsx`. Las pantallas ya
 * estaban escritas y la API ya estaba desplegada; lo unico que no existia era
 * quien las montara.
 *
 * QUIEN VE QUE, y por que:
 *
 *  - `ConsentimientoTrabajador` — GUARDIA y SUPERVISOR, que son los dos roles
 *    que operan desde la app y por lo tanto los unicos rastreables
 *    (`ROLE_PLATFORMS`). El servidor arma el mismo padron con ese criterio en
 *    `ConsentService.roster()`. ADMIN no va: no se le registra recorrido.
 *  - SUPERADMIN no lleva ninguna de las dos. No tiene tenant, y los endpoints
 *    corren dentro de la transaccion con contexto de empresa: pedirlos desde su
 *    panel devuelve 401 y pintaria un error donde no hay nada que hacer.
 *  - `ConsentimientoAdmin` — solo ADMIN. `/consent/roster` y
 *    `/consent/off-shift-audit` exigen `tenant:audit:read` y son de la empresa
 *    completa; el SUPERVISOR esta limitado a sus recintos asignados y una lista
 *    de toda la gente no cabe en ese alcance.
 */
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';

import type { AvisoConsentimiento } from './consentimiento-aviso';
import {
  ConsentimientoCumplimiento,
  type RegistroConsentimiento,
} from './consentimiento-cumplimiento';
import { ConsentimientoPolitica, type VersionAviso } from './consentimiento-politica';
import { ConsentimientoPuerta } from './consentimiento-puerta';

/**
 * El aviso del trabajador, envolviendo su pantalla.
 *
 * Los `children` son el panel normal. Se pasan hacia adentro para que la puerta
 * pueda no renderizarlos cuando toca leer el aviso: si se montara al lado, el
 * "primer ingreso" seria una tarjeta mas que se pasa de largo.
 */
export async function ConsentimientoTrabajador({
  apiUrl,
  children,
}: {
  apiUrl?: string;
  children?: ReactNode;
}) {
  const publica = apiUrl ?? process.env.NEXT_PUBLIC_API_URL ?? '/api';
  const aviso = await pedir<AvisoConsentimiento | null>('/consent/policy', null);

  return (
    <ConsentimientoPuerta avisoInicial={aviso} apiUrl={publica}>
      {children}
    </ConsentimientoPuerta>
  );
}

/**
 * Las dos pantallas de cumplimiento del ADMIN: publicar el aviso y demostrar
 * que no se registro ubicacion fuera de turno.
 */
export async function ConsentimientoAdmin({ apiUrl }: { apiUrl?: string } = {}) {
  const publica = apiUrl ?? process.env.NEXT_PUBLIC_API_URL ?? '/api';

  const [historial, registro] = await Promise.all([
    pedir<VersionAviso[] | null>('/consent/policies', null),
    pedir<RegistroConsentimiento | null>('/consent/roster', null),
  ]);

  // La version vigente sale del padron, que es quien la usa para decidir si cada
  // aceptacion esta al dia. Si el padron no cargo se cae al historial, que trae
  // la misma respuesta por otro camino.
  const versionVigente =
    registro?.currentVersion ?? historial?.find((entrada) => entrada.isCurrent)?.version ?? null;

  return (
    <>
      {historial ? (
        <ConsentimientoPolitica
          historialInicial={historial}
          versionVigente={versionVigente}
          apiUrl={publica}
        />
      ) : (
        <NoSePudoLeer
          id="aviso-geolocalizacion"
          titulo="Aviso de geolocalización"
          detalle="No pudimos leer el historial de avisos publicados. Vuelve a cargar la página; si sigue igual, revisa que tu cuenta pueda configurar las reglas de la empresa."
        />
      )}

      {registro ? (
        <ConsentimientoCumplimiento registro={registro} apiUrl={publica} />
      ) : (
        /*
         * A proposito NO se pasa un registro vacio inventado: pintaria
         * "0 de 0 al día" y "sin hallazgos", que es exactamente lo que un
         * fiscalizador leeria como cumplimiento cuando en realidad no se pudo
         * consultar nada.
         */
        <NoSePudoLeer
          id="registro-consentimiento"
          titulo="Registro de consentimiento"
          detalle="No pudimos leer quién aceptó el aviso ni revisar el período. No es que no haya hallazgos: es que no se pudo consultar. Vuelve a cargar la página."
        />
      )}
    </>
  );
}

function NoSePudoLeer({
  id,
  titulo,
  detalle,
}: {
  id: string;
  titulo: string;
  detalle: string;
}) {
  return (
    <section className="management-card management-wide" id={id}>
      <div className="card-heading">
        <div>
          <span className="eyebrow">Cumplimiento legal</span>
          <h2>{titulo}</h2>
        </div>
      </div>
      <div className="dashboard-empty">
        <strong>No pudimos leer esta información</strong>
        <span>{detalle}</span>
      </div>
    </section>
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
