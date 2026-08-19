'use client';

/**
 * Mapa base sobre OpenStreetMap (#75).
 *
 * Es el cimiento de las pantallas con mapa —editor de rutas (#95), monitoreo en
 * vivo (#97), recorrido de una ronda (#134)—, no una pantalla en si mismo. Recibe
 * puntos y trazas ya resueltos por quien lo usa y los dibuja. No pide datos, no
 * sabe de rondas y no formatea ni una fecha.
 *
 * ── La decision del issue: Leaflet, no MapLibre GL ────────────────────────────
 *
 * Leaflet. El argumento es el mismo que dejo las graficas dibujadas a mano en
 * `stats-charts-svg.tsx`: esta misma web se abre dentro de un WebView en
 * telefonos de gama baja que la empresa le entrega al guardia, y el criterio de
 * aceptacion pide que el mapa cargue en menos de 2 segundos con red movil.
 * MapLibre GL son ~220 kB comprimidos mas un contexto WebGL; Leaflet son ~42 kB
 * y dibuja con imagenes y DOM, que es lo que esos equipos hacen bien.
 *
 * Lo que MapLibre da a cambio —tiles vectoriales, rotacion, inclinacion— no sirve
 * para lo que hacemos: dentro de un recinto privado el mapa base no tiene datos
 * utiles, y lo que de verdad se mira son NUESTRAS capas (los puntos de control y
 * el recorrido del guardia). Pagar un motor vectorial para dibujar doce circulos
 * y una polilinea es al reves.
 *
 * Se revisa si algun dia hace falta rotar el mapa o servir planos interiores del
 * recinto en vectorial. Hoy no.
 *
 * ── De donde salen las imagenes ───────────────────────────────────────────────
 *
 * De la prop `origen` si la hay, y si no del contexto que deja
 * `ProveedorOrigenTiles` (`mapa-origen-tiles.tsx`), que lo resuelve en el
 * SERVIDOR leyendo `MAP_TILE_URL` en cada request. Nunca de
 * `tile.openstreetmap.org` en produccion: su politica prohibe el trafico de
 * aplicaciones reales y bloquea al que la incumple. Sin proveedor configurado el
 * mapa se dibuja sin fondo —los puntos y el recorrido se siguen viendo— con un
 * aviso a la vista. Un mapa sin foto es molesto; que nos corten el servicio a
 * todos los clientes es un incidente.
 *
 * El proveedor elegido y sus costos estan en
 * `docs/decisions/0002-proveedor-de-tiles-del-mapa.md`.
 *
 * ── Tres cosas que este archivo cuida ─────────────────────────────────────────
 *
 * 1. **Leaflet se carga cuando se ocupa.** `await import('leaflet')` lo deja en
 *    su propio chunk: las pantallas sin mapa no lo bajan. Y si el chunk no llega
 *    —un subterraneo, un WebView sin senal— la pantalla degrada a la lista de
 *    lugares en vez de romperse.
 * 2. **La atribucion se renderiza en el servidor**, no la pinta Leaflet. Es
 *    obligatoria por licencia y esta ahi aunque el mapa nunca cargue.
 * 3. **Nada de datos de personas afuera.** No se escribe una sola coordenada en
 *    consola ni en la URL: la ubicacion de un trabajador es dato sensible (ver
 *    docs/geolocalizacion-y-consentimiento.md). Los textos de los globos los
 *    arma quien llama y viajan como texto, nunca como HTML.
 *
 * Sobre las horas: este componente NO formatea fechas a proposito. La hora de un
 * escaneo se muestra en la zona horaria del RECINTO (`sites.timezone`), no en la
 * del servidor ni en la del navegador, y eso lo resuelve quien arma el `detalle`.
 */

import 'leaflet/dist/leaflet.css';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Layer, Map as MapaLeaflet } from 'leaflet';

import type { GeoPoint } from '@sentrycore/shared';

import { MapaAtribucion, MapaAviso } from './mapa-atribucion';
import { COLOR_MARCA, COLOR_TRAZA } from './mapa-colores';
import { MapaLeyenda, type ItemLeyenda } from './mapa-leyenda';
import {
  construirModelo,
  firmaDelContenido,
  type PuntoMapa,
  type TrazaMapa,
} from './mapa-modelo';
import { useOrigenTiles } from './mapa-origen-tiles';
import { formatearAtribucionTileLayer, ZOOM_INICIAL, type OrigenTiles } from './mapa-tiles';

export type {
  LineaMapa,
  ModeloMapa,
  PuntoMapa,
  TrazaMapa,
  VarianteMarca,
  VarianteTraza,
} from './mapa-modelo';
export type { ClaveLeyenda } from './mapa-colores';
export type { ItemLeyenda } from './mapa-leyenda';

type Leaflet = typeof import('leaflet');

export interface MapaBaseProps {
  /**
   * Que muestra el mapa, para quien usa lector de pantalla. Ej: "Recorrido de la
   * ronda en Sucursal Providencia". Sin nombres de personas.
   */
  etiqueta: string;
  puntos?: ReadonlyArray<PuntoMapa>;
  trazas?: ReadonlyArray<TrazaMapa>;
  /** Centro cuando no hay nada que encuadrar. Normalmente la ubicacion del recinto. */
  centro?: GeoPoint | null;
  /**
   * Zoom de arranque cuando no se puede encuadrar. Deberia venir de la regla
   * configurable `mapDefaultZoom` (ver INTEGRACION.md); mientras no exista, el
   * componente cae en `ZOOM_INICIAL`.
   */
  zoomPorDefecto?: number;
  /** Alto del mapa en CSS. El ancho lo pone el contenedor. */
  alto?: string;
  /** `false` deja el mapa quieto: para un informe o una vista de solo lectura. */
  interactivo?: boolean;
  /** Que decir cuando no hay ni una ubicacion cargada. */
  mensajeVacio?: string;
  /**
   * Que significa cada color. Se dibuja bajo el mapa y NO con Leaflet, asi que
   * sobrevive a que la libreria no cargue. Vacio = sin leyenda: en un mapa de un
   * solo tipo de marca es ruido.
   */
  leyenda?: ReadonlyArray<ItemLeyenda>;
  /**
   * Origen explicito. GANA sobre el contexto. Lo usa `RecorridoPatrulla`, que ya
   * recibe la plantilla del servidor por su cuenta, y sirve para las pruebas y
   * para un proveedor por empresa. Omitelo y se toma el del contexto.
   */
  origen?: OrigenTiles;
}

/* ------------------------------------------------------------------ */
/* Configuracion                                                       */
/* ------------------------------------------------------------------ */

const LADO_MARCA = 26;
const RELLENO_ENCUADRE: [number, number] = [28, 28];

const MENSAJE_VACIO_POR_DEFECTO =
  'Todavía no hay ubicaciones cargadas para mostrar en el mapa.';

const MENSAJE_SIN_LIBRERIA =
  'No se pudo cargar el mapa. Revisa la conexión; mientras tanto, estos son los lugares:';

type EstadoCarga = 'cargando' | 'listo' | 'sin-libreria';

/* ------------------------------------------------------------------ */
/* Componente                                                          */
/* ------------------------------------------------------------------ */

export function MapaBase({
  etiqueta,
  puntos = [],
  trazas = [],
  centro = null,
  zoomPorDefecto,
  alto = '24rem',
  interactivo = true,
  mensajeVacio = MENSAJE_VACIO_POR_DEFECTO,
  leyenda = [],
  origen,
}: MapaBaseProps) {
  const contenedorRef = useRef<HTMLDivElement | null>(null);
  const mapaRef = useRef<MapaLeaflet | null>(null);
  const leafletRef = useRef<Leaflet | null>(null);
  const [estado, setEstado] = useState<EstadoCarga>('cargando');
  /**
   * Cuantos mapas se han creado. Es lo que dispara el redibujo de las capas.
   *
   * No sirve mirar `estado`: si el mapa se rehace estando ya en 'listo', el
   * estado no cambia, React no vuelve a correr el efecto de las capas y el mapa
   * nuevo queda pelado —sin puntos y sin recorrido— sin que nada falle a la
   * vista. Un contador siempre cambia.
   */
  const [generacion, setGeneracion] = useState(0);

  // El hook va SIEMPRE, aunque venga la prop: llamarlo dentro de un `if` romperia
  // el orden de los hooks en cuanto una pantalla dejara de pasar `origen`.
  const origenDelContexto = useOrigenTiles();
  const origenEfectivo = origen ?? origenDelContexto;

  const zoom = zoomPorDefecto ?? ZOOM_INICIAL;
  const urlTiles = origenEfectivo.url;
  const maxZoom = origenEfectivo.maxZoom;

  const firma = useMemo(
    () => firmaDelContenido(puntos, trazas, centro),
    [puntos, trazas, centro],
  );

  const modelo = useMemo(
    () => construirModelo(puntos, trazas, centro),
    // Deliberado: la firma resume el contenido. Con `puntos` y `trazas` en la
    // lista, el modelo se rehace en cada render —llegan como arreglos nuevos— y
    // el mapa se re-encuadraria mientras el supervisor lo esta moviendo, que es
    // la falla mas irritante que puede tener un mapa.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [firma],
  );

  const hayMapa = !modelo.vacio;

  /* -------- Crear y destruir el mapa -------- */
  useEffect(() => {
    const nodo = contenedorRef.current;
    if (!nodo || !hayMapa) return undefined;

    // El mapa se rehace desde cero: el estado vuelve al principio. Sin esto, un
    // 'sin-libreria' de un intento anterior se queda pegado y la pantalla sigue
    // diciendo que el mapa no cargo mientras el mapa nuevo se ve perfecto detras.
    // En el primer montaje ya vale 'cargando' y React no vuelve a renderizar.
    setEstado('cargando');

    let vivo = true;
    let mapa: MapaLeaflet | null = null;
    let observador: ResizeObserver | null = null;

    void (async () => {
      let L: Leaflet;
      try {
        const modulo: Leaflet & { default?: Leaflet } = await import('leaflet');
        L = modulo.default ?? modulo;
      } catch {
        // Sin senal, o el chunk no llego. No se registra nada en consola: los
        // logs llevan tenant y request, no el estado de la pantalla de nadie.
        if (vivo) setEstado('sin-libreria');
        return;
      }
      if (!vivo) return;

      mapa = L.map(nodo, {
        // La atribucion la pintamos nosotros, siempre visible y en el estilo del panel.
        attributionControl: false,
        zoomControl: interactivo,
        dragging: interactivo,
        touchZoom: interactivo,
        doubleClickZoom: interactivo,
        boxZoom: interactivo,
        keyboard: interactivo,
        // La rueda del mouse zoomearia el mapa en vez de bajar la pagina y el
        // panel se volveria una trampa. Se zoomea con los botones o con dos dedos.
        scrollWheelZoom: false,
        // Canvas para la polilinea: en un telefono de gama baja una traza de
        // cientos de puntos dibujada en SVG se arrastra.
        preferCanvas: true,
      });

      if (urlTiles) {
        L.tileLayer(urlTiles, {
          attribution: formatearAtribucionTileLayer(origenEfectivo.atribucionProveedor),
          maxZoom,
          // Con red movil mala, menos peticiones: los tiles se piden al soltar y
          // no en cada pixel de arrastre, y se guarda un anillo de reserva.
          updateWhenIdle: true,
          keepBuffer: 1,
        }).addTo(mapa);
      }

      leafletRef.current = L;
      mapaRef.current = mapa;

      // Un mapa que nace dentro de una pestana oculta o de una tarjeta que cambia
      // de tamano queda con los tiles corridos hasta que alguien lo mueve.
      if (typeof ResizeObserver !== 'undefined') {
        observador = new ResizeObserver(() => mapaRef.current?.invalidateSize());
        observador.observe(nodo);
      }

      setEstado('listo');
      setGeneracion((anterior) => anterior + 1);
    })();

    return () => {
      vivo = false;
      observador?.disconnect();
      leafletRef.current = null;
      mapaRef.current = null;
      // Deja el contenedor limpio: sin esto, el segundo montaje se cae con
      // "Map container is already initialized".
      mapa?.remove();
    };
  }, [hayMapa, interactivo, urlTiles, maxZoom, origenEfectivo.atribucionProveedor]);

  /* -------- Sincronizar las capas -------- */
  useEffect(() => {
    if (generacion === 0) return undefined;
    const L = leafletRef.current;
    const mapa = mapaRef.current;
    if (!L || !mapa) return undefined;

    const capas: Layer[] = [];

    // Las lineas van primero para que las marcas queden encima.
    for (const linea of modelo.lineas) {
      capas.push(
        L.polyline(linea.coordenadas, {
          color: COLOR_TRAZA[linea.variante],
          weight: 4,
          opacity: 0.9,
          lineJoin: 'round',
          lineCap: 'round',
          // La ruta planificada va punteada y el recorrido real continuo: se
          // distinguen sin depender del color.
          dashArray: linea.variante === 'ruta' ? '6 7' : undefined,
        }).addTo(mapa),
      );
    }

    for (const marca of modelo.marcas) {
      const marcador = L.marker([marca.lat, marca.lng], {
        icon: L.divIcon({
          // Sin la clase por defecto de Leaflet, que trae fondo y borde propios.
          className: '',
          html: marcaHtml(marca),
          iconSize: [LADO_MARCA, LADO_MARCA],
          iconAnchor: [LADO_MARCA / 2, LADO_MARCA / 2],
          // El globo se abre ARRIBA de la marca. Sin esto sale centrado en ella
          // y tapa justo el punto que se acaba de tocar.
          popupAnchor: [0, -LADO_MARCA / 2],
        }),
        title: marca.titulo,
        alt: marca.titulo,
        keyboard: interactivo,
      }).addTo(mapa);

      marcador.bindPopup(globoDe(marca));
      capas.push(marcador);
    }

    if (modelo.encuadre.length > 0) {
      // `maxZoom` acota el caso de un punto solo: sin eso, encuadrar un unico
      // punto amplia hasta el maximo del proveedor y se ve el techo de una casa.
      mapa.fitBounds(L.latLngBounds(modelo.encuadre), {
        padding: RELLENO_ENCUADRE,
        maxZoom: Math.min(zoom, maxZoom),
      });
    } else if (modelo.centro) {
      mapa.setView(modelo.centro, Math.min(zoom, maxZoom));
    }

    return () => {
      for (const capa of capas) capa.remove();
    };
  }, [generacion, modelo, zoom, maxZoom, interactivo]);

  /* -------- Render -------- */

  return (
    <figure className="mapa" style={{ margin: 0 }}>
      <MapaAviso aviso={origenEfectivo.aviso} />

      {hayMapa ? (
        <div style={{ position: 'relative' }}>
          <div
            ref={contenedorRef}
            className="mapa-lienzo"
            role="region"
            aria-label={etiqueta}
            style={{
              height: alto,
              width: '100%',
              border: '1px solid #e6e9f0',
              borderRadius: '1rem',
              // Con el fondo apagado, un gris parejo deja claro que no falta
              // cargar nada: lo que se ve es todo lo que hay.
              background: '#eef1f6',
              // Leaflet dibuja los tiles fuera del recuadro si no se recorta.
              overflow: 'hidden',
            }}
          />
          {estado === 'cargando' ? (
            <p
              style={{
                position: 'absolute',
                inset: 0,
                display: 'grid',
                placeItems: 'center',
                margin: 0,
                color: '#687086',
                fontSize: '.78rem',
              }}
            >
              Cargando el mapa…
            </p>
          ) : null}
        </div>
      ) : (
        <p
          className="mapa-vacio"
          style={{
            margin: 0,
            border: '1px dashed #d9deea',
            borderRadius: '1rem',
            padding: '1.5rem',
            color: '#687086',
            fontSize: '.8rem',
            lineHeight: 1.6,
            textAlign: 'center',
          }}
        >
          {mensajeVacio}
        </p>
      )}

      {estado === 'sin-libreria' ? (
        <p
          role="alert"
          style={{
            margin: '.6rem 0 0',
            border: '1px solid #f2cbd0',
            borderRadius: '.65rem',
            padding: '.6rem .75rem',
            color: '#a93744',
            background: '#fff5f6',
            fontSize: '.72rem',
            lineHeight: 1.5,
          }}
        >
          {MENSAJE_SIN_LIBRERIA}
        </p>
      ) : null}

      <MapaLeyenda items={leyenda} />

      <ListaDeLugares puntos={puntos} abierta={estado === 'sin-libreria'} />

      <MapaAtribucion origen={origenEfectivo} />
    </figure>
  );
}

/* ------------------------------------------------------------------ */
/* El gemelo en texto                                                  */
/* ------------------------------------------------------------------ */

/**
 * La misma informacion, en lista.
 *
 * Es el equivalente de la tabla que acompana a cada grafica: un mapa que solo
 * comunica por posicion no sirve impreso, ni para quien usa lector de pantalla,
 * ni cuando la libreria no llego. Va con los NOMBRES, no con las coordenadas:
 * una lista de latitudes es dato sensible y ademas no le dice nada a nadie.
 */
function ListaDeLugares({
  puntos,
  abierta,
}: {
  puntos: ReadonlyArray<PuntoMapa>;
  abierta: boolean;
}) {
  const conNombre = puntos.filter((punto) => punto.titulo.trim().length > 0);
  if (conNombre.length === 0) return null;

  return (
    <details className="mapa-detalle" open={abierta} style={{ marginTop: '.6rem' }}>
      <summary style={{ color: '#4d566b', cursor: 'pointer', fontSize: '.72rem', fontWeight: 700 }}>
        Ver los lugares en lista ({conNombre.length})
      </summary>
      <ul
        style={{ margin: '.5rem 0 0', padding: '0 0 0 1.1rem', fontSize: '.72rem', lineHeight: 1.7 }}
      >
        {conNombre.map((punto) => (
          <li key={punto.id}>
            {typeof punto.numero === 'number' ? `${punto.numero}. ` : ''}
            {punto.titulo}
            {punto.detalle ? <span style={{ color: '#687086' }}> — {punto.detalle}</span> : null}
          </li>
        ))}
      </ul>
    </details>
  );
}

/* ------------------------------------------------------------------ */
/* Piezas de Leaflet                                                   */
/* ------------------------------------------------------------------ */

/**
 * El circulo de la marca.
 *
 * Se usa `divIcon` y no el icono por defecto de Leaflet a proposito: el icono
 * por defecto es un PNG que se pide con una ruta relativa que ningun bundler
 * resuelve, y termina en el clasico mapa con los marcadores rotos.
 *
 * Lo unico que entra al HTML es un numero que genera este archivo. El texto que
 * viene de la empresa va por `textContent` en el globo, nunca aca.
 */
function marcaHtml(punto: PuntoMapa): string {
  const color = COLOR_MARCA[punto.variante ?? 'punto'];
  const numero =
    typeof punto.numero === 'number' && Number.isFinite(punto.numero)
      ? String(Math.trunc(punto.numero))
      : '';
  const estilo = [
    'display:grid',
    'place-items:center',
    `width:${LADO_MARCA}px`,
    `height:${LADO_MARCA}px`,
    'border-radius:50%',
    'border:2px solid #ffffff',
    'box-shadow:0 2px 6px rgba(24,38,72,.35)',
    `background:${color}`,
    'color:#ffffff',
    'font:800 11px/1 Inter,system-ui,sans-serif',
  ].join(';');

  return `<span style="${estilo}">${numero}</span>`;
}

/**
 * El globo del marcador, armado como nodos del DOM.
 *
 * Nada de plantillas de HTML: el nombre de un recinto lo escribe el cliente en
 * su panel, y concatenarlo dentro de un string seria una inyeccion esperando.
 * `textContent` no interpreta nada.
 */
function globoDe(punto: PuntoMapa): HTMLElement {
  const caja = document.createElement('div');
  caja.style.minWidth = '9rem';

  const titulo = document.createElement('strong');
  titulo.textContent = punto.titulo;
  titulo.style.display = 'block';
  titulo.style.fontSize = '.78rem';
  caja.append(titulo);

  if (punto.detalle) {
    const detalle = document.createElement('small');
    detalle.textContent = punto.detalle;
    detalle.style.display = 'block';
    detalle.style.marginTop = '.2rem';
    detalle.style.color = '#687086';
    detalle.style.fontSize = '.68rem';
    caja.append(detalle);
  }

  return caja;
}
