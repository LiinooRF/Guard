/**
 * Pantalla del mapa de recintos (#75).
 *
 * El mapa base ya existia como componente y no lo usaba nadie: este es el
 * montaje en una pantalla de verdad, con datos de la API y con permisos.
 *
 * ── Que ve cada rol ───────────────────────────────────────────────────────────
 *
 * ADMIN       `GET /api/admin/sites` (tenant:sites:manage) — todos los recintos
 *             de su empresa, y al elegir uno, sus puntos de control con
 *             `GET /api/admin/sites/:siteId/checkpoints`.
 * SUPERVISOR  `GET /api/supervisor/sites` (patrols:monitor) — SOLO los
 *             recintos que tiene asignados. El recorte lo hace el servidor:
 *             `listAssignedSites()` filtra con
 *             `JOIN sites s ON s.tenant_id = ss.tenant_id AND s.id = ss.site_id
 *             WHERE ss.supervisor_id = $1`, que es lo unico que vale — el rol no
 *             alcanza. Por eso la pantalla nunca llama al catalogo de
 *             administracion con su sesion.
 * SUPERADMIN  404. No tiene contexto de empresa: entra a los datos de un tenant
 *             por la ventana de soporte auditada (#109), que es otra pantalla.
 * GUARDIA     404. Su carril es la app, y el middleware ya lo saca del navegador.
 *
 * `patrols:monitor` —no `shifts:manage`— es el permiso REAL del endpoint, leido
 * de `supervisor.controller.ts` y de la fila que ya esta en
 * `authorization-matrix.spec.ts`. Solo lo tiene SUPERVISOR (`permissions.ts`).
 *
 * ── Endpoints nuevos: ninguno ─────────────────────────────────────────────────
 *
 * Todo sale de endpoints que ya existen y ya tienen su fila en la matriz de
 * autorizacion. Un id de recinto que llega por la URL se vuelve a comparar
 * contra la lista que entrego el servidor antes de usarlo (ver
 * `recintoElegido`): la API igual responde 403, pero la interfaz no tiene por
 * que pedirselo.
 */

import { cookies } from 'next/headers';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { DashboardShell, type MarcaDelShell } from '../../../_components/dashboard-shell';
import { marcaDelTenant } from '../../../_lib/marca-del-tenant';
import { ProveedorOrigenTiles } from '../../../_components/mapa-origen-tiles';
import { MapaRecintos } from '../../../_components/mapa-recintos';
import {
  recintoElegido,
  zoomDeLasReglas,
  type PuntoDeControlDelMapa,
  type RecintoDelMapa,
} from '../../../_components/mapa-recintos-datos';
import { entornoDeTilesDelServidor, resolverOrigenTiles } from '../../../_components/mapa-tiles';

export const metadata: Metadata = {
  title: 'Mapa de recintos',
};

/** Los dos roles de escritorio que tienen recintos que mirar. */
const ROLES_CON_MAPA = {
  admin: { role: 'ADMIN', alcance: 'empresa' },
  supervisor: { role: 'SUPERVISOR', alcance: 'asignados' },
} as const;

interface ModulosDeLaEmpresa {
  enabled?: Record<string, boolean> | null;
}

interface ReglasEfectivas {
  rules?: unknown;
}

export default async function PantallaDeMapa({
  params,
  searchParams,
}: {
  params: Promise<{ role: string }>;
  // La eleccion de recinto vive en la URL: se comparte, se marca y no necesita
  // JavaScript. Un UUID de recinto no es dato de una persona.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { role } = await params;
  const configuracion = ROLES_CON_MAPA[role as keyof typeof ROLES_CON_MAPA];
  if (!configuracion) notFound();

  const esAdmin = role === 'admin';
  const consulta = await searchParams;

  const [modulos, recintos] = await Promise.all([
    pedir<ModulosDeLaEmpresa | null>('/features', null),
    esAdmin
      ? pedir<RecintoDelMapa[]>('/admin/sites', [])
      : pedir<RecintoDelMapa[]>('/supervisor/sites', []),
  ]);

  const pedido = primerValor(consulta.recinto);
  const elegidoId = recintoElegido(recintos, pedido);

  // Cada rol pide los puntos por SU puerta. El ADMIN por el catalogo de
  // administracion (`tenant:sites:manage`, tenant completo) y el SUPERVISOR por
  // el suyo (#309: `checkpoints:manage`, acotado a sus recintos asignados). Hasta
  // ese issue el supervisor veia el mapa sin un solo punto, porque la unica ruta
  // que existia le daba 403; pedirle la del admin sigue siendo un 403 seguro y un
  // registro de acceso denegado por nada.
  const [puntosDeControl, reglas] = await Promise.all([
    elegidoId
      ? pedir<PuntoDeControlDelMapa[]>(
          esAdmin
            ? `/admin/sites/${encodeURIComponent(elegidoId)}/checkpoints`
            : `/checkpoints/supervisor/sites/${encodeURIComponent(elegidoId)}/checkpoints`,
          [],
        )
      : Promise.resolve<PuntoDeControlDelMapa[]>([]),
    pedir<ReglasEfectivas>(
      elegidoId ? `/rules/effective?siteId=${encodeURIComponent(elegidoId)}` : '/rules/effective',
      {},
    ),
  ]);

  // `map` apagado = el mapa desaparece y queda la lista, tal como dice la ficha
  // del modulo. Falla CERRADO a proposito: solo se dibuja si el servidor dijo
  // que si. Si /features no responde no se sabe que contrato la empresa, y la
  // convencion del repo es que un modulo que no consta no se pinta
  // (FeatureFlagsService.assertEnabled responde 404, no 403). Aca pesa el doble,
  // porque esta pantalla no llama a nada con assertEnabled: este es el unico
  // control que hay. Sin el flag queda la lista de lugares, no una pantalla en
  // blanco.
  const mapaHabilitado = modulos?.enabled?.map === true;

  // La marca de la empresa (#117): misma resolucion en servidor que en el
  // panel principal, para que esta pantalla no pinte la marca del producto
  // mientras el resto pinta la del cliente.
  const tema = await marcaDelTenant();
  const marca: MarcaDelShell = {
    commercialName: tema.branding.commercialName,
    logoUri: tema.branding.logoUri,
    cssVariables: tema.cssVariables,
  };

  return (
    <DashboardShell
      role={configuracion.role}
      marca={marca}
      title="Mapa de recintos"
      subtitle={
        esAdmin
          ? 'Dónde está cada recinto de la empresa y sus puntos de control.'
          : 'Dónde están los recintos que tienes asignados.'
      }
    >
      <p style={{ margin: '0 0 1rem' }}>
        <Link
          href={`/app/${role}`}
          className="secondary-button"
          style={{ display: 'inline-flex', textDecoration: 'none' }}
        >
          ← Volver al panel
        </Link>
      </p>

      {/*
        El fondo del mapa sale de AQUI y no puede salir de otro lado.

        `MapaRecintos -> MapaBase` resuelve el origen por contexto, y sin este
        proveedor cae a `ORIGEN_DE_COMPILACION`, que en produccion SIEMPRE vale
        'sin-configurar': `MAP_TILE_URL` llega al contenedor en tiempo de
        ejecucion y `NEXT_PUBLIC_*` se hornea al compilar. El resultado era esta
        pantalla dibujando los puntos sobre nada y diciendo "el fondo del mapa no
        esta configurado" con MapTiler perfectamente configurado en Dokploy.

        Este componente es de servidor y es dinamico (lee `cookies()` en
        `pedir()`), asi que `process.env` se lee en cada request, que es la
        condicion que `entornoDeTilesDelServidor` pide por escrito.

        Guardia: `mapa-proveedor-montado.spec.ts` — si otra pantalla monta un
        mapa que depende del contexto y se olvida de envolverlo, falla ahi.
      */}
      <ProveedorOrigenTiles origen={resolverOrigenTiles(entornoDeTilesDelServidor(process.env))}>
        <MapaRecintos
          recintos={recintos}
          puntosDeControl={puntosDeControl}
          recintoPedido={pedido}
          rutaBase={`/app/${role}/mapa`}
          alcance={configuracion.alcance}
          mapaHabilitado={mapaHabilitado}
          zoomPorDefecto={zoomDeLasReglas(reglas.rules)}
          puedeVerPuntos={esAdmin}
        />
      </ProveedorOrigenTiles>
    </DashboardShell>
  );
}

/* ------------------------------------------------------------------ */
/* Acceso a la API                                                     */
/* ------------------------------------------------------------------ */

/**
 * GET autenticado desde el servidor, con el mismo patron que usa
 * `app/app/[role]/page.tsx`: la cookie de sesion viaja a mano porque `fetch` del
 * servidor no arrastra las del navegador, y `API_INTERNAL_URL` va por la red
 * interna de Docker sin salir a internet.
 *
 * Un fallo devuelve el valor de respaldo y no revienta la pantalla: una sesion
 * recien vencida o un recinto borrado en otra pestana son estados normales, no
 * errores de programacion. Nada se escribe en consola: los registros llevan
 * tenant y request, no lo que le pasa a la pantalla de alguien.
 *
 * OJO al elegir el respaldo: para una lista, `[]` es honesto ("no hay nada que
 * mostrar"). Para una decision de permiso o de modulo NO lo es, porque un objeto
 * vacio se lee igual que un "no". Por eso `/features` usa `null` y quien lo
 * consume distingue "apagado" de "no se pudo saber".
 */
async function pedir<T>(ruta: string, respaldo: T): Promise<T> {
  const galletas = await cookies();
  const acceso = galletas.get('sentrycore_access');
  if (!acceso) return respaldo;

  const base = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? '/api';
  try {
    const respuesta = await fetch(`${base}${ruta}`, {
      headers: { cookie: `sentrycore_access=${acceso.value}` },
      cache: 'no-store',
    });
    if (!respuesta.ok) return respaldo;
    return (await respuesta.json()) as T;
  } catch {
    return respaldo;
  }
}

/** Un parametro repetido en la URL llega como arreglo; se usa el primero. */
function primerValor(valor: string | string[] | undefined): string | null {
  if (Array.isArray(valor)) return valor[0] ?? null;
  return valor ?? null;
}
