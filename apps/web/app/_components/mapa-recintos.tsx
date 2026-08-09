/**
 * El mapa base montado sobre datos reales: recintos y puntos de control (#75).
 *
 * `MapaBase` dibuja lo que le pasan y no pide datos. Esta es la pieza que le da
 * de comer en la pantalla `/app/<rol>/mapa`: recibe lo que respondio la API,
 * traduce con `mapa-recintos-datos.ts` y arma la leyenda con lo que de verdad
 * quedo dibujado.
 *
 * ── Las dos pantallas que lo usan ─────────────────────────────────────────────
 *
 * `/app/admin/mapa` con `alcance='empresa'` y `puedeVerPuntos`, y
 * `/app/supervisor/mapa` con `alcance='asignados'` y sin puntos de control: el
 * catalogo que los lista es de administracion y el SUPERVISOR no tiene
 * `tenant:sites:manage`. Los dos textos distintos existen por eso, no por
 * adorno: "no hay recintos" significa cosas muy distintas para cada uno.
 *
 * ── Sin `'use client'`, y es a proposito ──────────────────────────────────────
 *
 * La eleccion de recinto viaja en la URL (`?recinto=<id>`) y el selector son
 * enlaces, no un `<select>` con estado. Asi este archivo no suma ni un byte de
 * JavaScript al navegador —el unico bulto del carril es Leaflet, que ademas se
 * baja en su propio chunk cuando hace falta—, la eleccion se puede compartir y
 * marcar, y funciona antes de que hidrate nada. Esta misma web se abre dentro de
 * un WebView en telefonos de gama baja: cada kB se paga en segundos de terreno.
 *
 * ── El modulo `map` de la empresa ─────────────────────────────────────────────
 *
 * Es un SaaS con modulos por licencia. La ficha de `map` en el catalogo dice,
 * textual, que hacer cuando esta apagado: "Desaparece el mapa del panel. La
 * ronda se sigue igual por la lista de puntos y sus horas". Apagado NO es un
 * mapa gris con un candado: es que no hay mapa y queda la lista.
 */

import Link from 'next/link';

import { MapaBase } from './mapa-base';
import type { ItemLeyenda } from './mapa-leyenda';
import type { PuntoMapa } from './mapa-modelo';
import {
  armarMarcas,
  centroDelRecinto,
  estaActivo,
  recintoElegido,
  resumenDeUbicaciones,
  type PuntoDeControlDelMapa,
  type RecintoDelMapa,
} from './mapa-recintos-datos';

const COLOR_TENUE = '#687086';

export type AlcanceDelMapa = 'empresa' | 'asignados';

export interface MapaRecintosProps {
  /** Ya acotados por el servidor: la empresa completa, o los recintos asignados. */
  recintos: ReadonlyArray<RecintoDelMapa>;
  /** Puntos del recinto elegido. Vacio si no hay eleccion o si el rol no los ve. */
  puntosDeControl: ReadonlyArray<PuntoDeControlDelMapa>;
  /** Lo pedido en la URL. Se vuelve a validar contra la lista, no se confia. */
  recintoPedido?: string | null;
  /** Ruta de esta pantalla, para armar los enlaces del selector. */
  rutaBase: string;
  alcance: AlcanceDelMapa;
  /** El modulo `map` de la empresa (`GET /api/features`). */
  mapaHabilitado: boolean;
  /** Zoom de arranque de las reglas efectivas, si la empresa lo configuro. */
  zoomPorDefecto?: number | undefined;
  /** `false` cuando el rol no tiene permiso para listar puntos de control. */
  puedeVerPuntos: boolean;
}

export function MapaRecintos({
  recintos,
  puntosDeControl,
  recintoPedido = null,
  rutaBase,
  alcance,
  mapaHabilitado,
  zoomPorDefecto,
  puedeVerPuntos,
}: MapaRecintosProps) {
  const elegidoId = recintoElegido(recintos, recintoPedido);
  const marcas = armarMarcas({ recintos, elegidoId, puntosDeControl });
  const resumen = resumenDeUbicaciones(recintos);
  const centro = centroDelRecinto(recintos, elegidoId);
  const elegido = recintos.find((recinto) => recinto.id === elegidoId) ?? null;

  const visibles = recintos.filter(estaActivo);
  const deLaEmpresa = alcance === 'empresa';

  return (
    <section className="activity-card" id="mapa">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Ubicaciones</span>
          <h2>{elegido ? elegido.name : 'Mapa de recintos'}</h2>
        </div>
        <span className="status-pill">
          {resumen.conUbicacion} de {resumen.activos} con ubicación
        </span>
      </div>

      <p className="section-explanation">
        {deLaEmpresa
          ? 'Dónde está cada recinto de la empresa. Elige uno para ver sus puntos de control en el mapa.'
          : 'Dónde están los recintos que tienes asignados. Solo aparecen esos.'}
      </p>

      {visibles.length === 0 ? (
        <div className="dashboard-empty">
          <strong>No hay recintos para mostrar</strong>
          <span>
            {deLaEmpresa
              ? 'Crea el primer recinto en la sección Recintos y agrégale su ubicación.'
              : 'Pídele a un administrador de la empresa que te asigne un recinto.'}
          </span>
        </div>
      ) : (
        <>
          <SelectorDeRecintos
            recintos={visibles}
            elegidoId={elegidoId}
            rutaBase={rutaBase}
          />

          {mapaHabilitado ? (
            <MapaBase
              // Sin nombres de personas: el nombre de un recinto no lo es.
              etiqueta={
                elegido
                  ? `Ubicación de ${elegido.name}${puedeVerPuntos ? ' y sus puntos de control' : ''}`
                  : 'Ubicación de los recintos'
              }
              puntos={marcas}
              centro={centro}
              zoomPorDefecto={zoomPorDefecto}
              alto="28rem"
              mensajeVacio={mensajeSinUbicaciones(deLaEmpresa, elegido !== null)}
              leyenda={leyendaDe(marcas)}
            />
          ) : (
            <ModuloApagado puntos={marcas} />
          )}

          {elegido && !puedeVerPuntos ? (
            <p className="section-explanation">
              El detalle de los puntos de control lo entrega el catálogo de administración de la
              empresa, así que con tu perfil se muestra solo la ubicación del recinto.
            </p>
          ) : null}

          {resumen.sinUbicacion > 0 ? (
            <p className="section-explanation">
              {resumen.sinUbicacion === 1
                ? 'Hay 1 recinto sin ubicación cargada, así que no aparece en el mapa.'
                : `Hay ${resumen.sinUbicacion} recintos sin ubicación cargada, así que no aparecen en el mapa.`}{' '}
              {deLaEmpresa
                ? 'La ubicación se agrega al crear o editar el recinto.'
                : 'Pídele a un administrador que las cargue.'}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Selector                                                            */
/* ------------------------------------------------------------------ */

/**
 * Elegir recinto sin JavaScript.
 *
 * Son enlaces con la eleccion en la URL: se comparten, se marcan y el boton
 * "atras" del navegador hace lo que uno espera. `next/link` navega sin recargar
 * la pagina completa.
 */
function SelectorDeRecintos({
  recintos,
  elegidoId,
  rutaBase,
}: {
  recintos: ReadonlyArray<RecintoDelMapa>;
  elegidoId: string | null;
  rutaBase: string;
}) {
  return (
    <nav
      aria-label="Recintos"
      className="mapa-selector"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: '.4rem',
        margin: '1rem 0 .9rem',
      }}
    >
      <EnlaceDeRecinto href={rutaBase} activo={elegidoId === null}>
        Todos
      </EnlaceDeRecinto>
      {recintos.map((recinto) => (
        <EnlaceDeRecinto
          key={recinto.id}
          href={`${rutaBase}?recinto=${encodeURIComponent(recinto.id)}`}
          activo={recinto.id === elegidoId}
        >
          {recinto.name}
        </EnlaceDeRecinto>
      ))}
    </nav>
  );
}

function EnlaceDeRecinto({
  href,
  activo,
  children,
}: {
  href: string;
  activo: boolean;
  children: string;
}) {
  return (
    <Link
      href={href}
      aria-current={activo ? 'true' : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        minHeight: '2.2rem',
        border: `1px solid ${activo ? 'var(--marca-secundario, #4263eb)' : '#e6e9f0'}`,
        borderRadius: '99px',
        padding: '.35rem .75rem',
        color: activo ? '#ffffff' : '#4d566b',
        background: activo ? 'var(--marca-secundario, #4263eb)' : '#ffffff',
        fontSize: '.7rem',
        fontWeight: 700,
      }}
    >
      {children}
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* Estados sin mapa                                                    */
/* ------------------------------------------------------------------ */

/**
 * El modulo apagado.
 *
 * No se dibuja un mapa bloqueado ni se nombra el modulo que la empresa no
 * contrato: queda la misma lista de lugares que acompana al mapa cuando la
 * libreria no carga. La informacion no se pierde, el mapa si.
 */
function ModuloApagado({ puntos }: { puntos: ReadonlyArray<PuntoMapa> }) {
  if (puntos.length === 0) {
    return (
      <div className="dashboard-empty">
        <strong>Sin ubicaciones que mostrar</strong>
        <span>Los recintos visibles todavía no tienen su ubicación cargada.</span>
      </div>
    );
  }

  return (
    <ul
      className="mapa-lista-simple"
      style={{ margin: '.4rem 0 0', padding: '0 0 0 1.1rem', fontSize: '.75rem', lineHeight: 1.8 }}
    >
      {puntos.map((punto) => (
        <li key={punto.id}>
          {punto.titulo}
          {punto.detalle ? <span style={{ color: COLOR_TENUE }}> — {punto.detalle}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* Detalles                                                            */
/* ------------------------------------------------------------------ */

function mensajeSinUbicaciones(deLaEmpresa: boolean, hayEleccion: boolean): string {
  if (hayEleccion) {
    return deLaEmpresa
      ? 'Este recinto todavía no tiene ubicación cargada, ni sus puntos de control. Puedes agregarla al editar el recinto o cada punto.'
      : 'Este recinto todavía no tiene ubicación cargada. Pídele a un administrador de la empresa que la agregue.';
  }
  return deLaEmpresa
    ? 'Ningún recinto tiene ubicación cargada todavía, así que el mapa está vacío. La ubicación se agrega al crear o editar cada recinto.'
    : 'Ninguno de tus recintos tiene ubicación cargada todavía. Pídele a un administrador de la empresa que la agregue.';
}

/**
 * La leyenda sale de lo que QUEDO dibujado, no de lo que se pidio dibujar.
 *
 * Un recinto sin puntos criticos no tiene por que mostrar el rojo en la leyenda:
 * un color explicado que no aparece en el mapa hace buscar algo que no existe.
 */
function leyendaDe(marcas: ReadonlyArray<PuntoMapa>): ItemLeyenda[] {
  const items: ItemLeyenda[] = [];
  if (marcas.some((marca) => marca.variante === 'recinto')) {
    items.push({ clave: 'recinto', texto: 'Recinto' });
  }
  if (marcas.some((marca) => marca.variante === 'punto')) {
    items.push({ clave: 'punto', texto: 'Punto de control' });
  }
  if (marcas.some((marca) => marca.variante === 'alerta')) {
    items.push({ clave: 'alerta', texto: 'Acceso crítico' });
  }
  // Un solo tipo de marca no necesita leyenda: seria una linea que no explica nada.
  return items.length > 1 ? items : [];
}
