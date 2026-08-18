import type { ScanAnomaly } from '@sentrycore/shared';

import { haversineM } from '../geo/haversine';
import type { FilaPunto } from './patrol-report.model';

/**
 * Mapa del recorrido de la ronda (#79): filas crudas de la base -> modelo listo
 * para dibujar.
 *
 * Esta capa es PURA a proposito, igual que patrol-report.model.ts: no importa
 * pdfkit, ni Nest, ni toca la base. Aca vive la aritmetica que se equivoca en
 * silencio —una proyeccion mal escalada, un encuadre de lado cero, un numeric
 * que llego como string— y por eso esta afuera del dibujo, donde se puede
 * probar sin generar un PDF.
 *
 * ---------------------------------------------------------------------------
 * POR QUE EL MAPA NO LLEVA CARTOGRAFIA DE FONDO
 * ---------------------------------------------------------------------------
 * 1. Los tiles publicos de OpenStreetMap prohiben el trafico de aplicaciones
 *    reales y bloquean a quien los usa (ver CLAUDE.md). No son una opcion.
 * 2. El informe tambien se genera en un worker de BullMQ al cerrar la ronda
 *    (#86). Meter una descarga HTTP en ese camino convierte "se cayo internet"
 *    en "no hay informe", y el informe es la entrega del producto.
 * 3. Dentro de un recinto privado —galpones, patios, estacionamientos
 *    subterraneos— ni OSM ni Google tienen nada dibujado. Lo que el jefe de
 *    operaciones necesita leer es la posicion RELATIVA entre los puntos y por
 *    donde paso el guardia, y eso es justo lo que entrega un plano a escala con
 *    barra de escala y norte.
 *
 * Si algun dia hay un proveedor de tiles contratado, el fondo entra como una
 * imagen debajo de esta capa vectorial y nada de este archivo cambia.
 * ---------------------------------------------------------------------------
 */

const RADIO_TIERRA_M = 6_371_000;

/**
 * Lado minimo del encuadre, en metros.
 *
 * No es una regla de negocio sino un piso de dibujo: sin el, una ronda con
 * todos los puntos en el mismo pasillo se dibujaria con un zoom tal que el
 * error normal del GPS (5-15 m) ocuparia media hoja y el informe mostraria un
 * recorrido erratico que nunca ocurrio.
 */
export const SPAN_MINIMO_M = 60;

/** Aire alrededor del contenido para que ninguna marca quede pegada al borde. */
const MARGEN_ENCUADRE = 0.08;

/**
 * Cuanto puede estirar el plano un escaneo con GPS malo, en veces el tamano del
 * recinto dibujado.
 *
 * Un escaneo marcado `fuera_de_radio_gps` es, por definicion, el dato mas
 * probable de estar equivocado: cuando el telefono entrega un fix delirante, la
 * posicion cae a kilometros. Si esa marca entrara al encuadre, el recinto
 * completo quedaria reducido a un punto y el informe perderia el mapa entero
 * por una sola lectura mala. Los que pasan de este alcance no se dibujan: se
 * cuentan y se explican en una nota, que es informacion util y no una mancha.
 *
 * Es un factor sin unidad —relativo al propio recinto— y no una distancia en
 * metros: por eso no es un parametro de negocio de rules.ts.
 *
 * Deliberadamente generoso (cinco veces el recinto): el objetivo es descartar
 * el fix delirante de kilometros, no la desviacion de cien metros, que es
 * justamente la que hay que mirar.
 */
const ALCANCE_ESCANEO_DESVIADO = 5;

/**
 * Las dos marcas que hablan de la POSICION del escaneo. Las otras
 * (reloj_desfasado, dispositivo_duplicado, velocidad_imposible) son senales
 * validas pero no se dibujan en el mapa: no dicen donde estaba el telefono.
 */
export const ANOMALIAS_GPS: readonly ScanAnomaly[] = ['fuera_de_radio_gps', 'sin_fix_gps'];

// --------------------------------------------------------------- filas crudas

/** checkpoints.latitude / longitude son numeric(9,6) NULLABLE: llegan string o null. */
export interface CoordenadaPuntoRow {
  id: string;
  latitude: string | null;
  longitude: string | null;
}

/** patrol_tracks. latitude/longitude son NOT NULL; accuracy_m puede faltar. */
export interface TrazaRow {
  recorded_at_device: Date;
  latitude: string;
  longitude: string;
  accuracy_m: string | null;
}

/** scans. Un escaneo sin fix GPS guarda las coordenadas en NULL. */
export interface EscaneoGpsRow {
  checkpoint_id: string;
  scanned_at_server: Date;
  latitude: string | null;
  longitude: string | null;
  accuracy_m: string | null;
  anomalies: ScanAnomaly[] | null;
}

/** sites.latitude / longitude: solo se usan como origen de respaldo. */
export interface RecintoCoordRow {
  latitude: string | null;
  longitude: string | null;
}

// ------------------------------------------------------------------- modelo

export interface Coordenada {
  readonly lat: number;
  readonly lng: number;
}

/** Metros locales respecto del origen. Norte positivo hacia arriba. */
export interface PosicionMapa {
  readonly este: number;
  readonly norte: number;
}

export interface MarcaPuntoMapa extends PosicionMapa {
  /** El mismo numero que lleva el punto en la tabla del informe. */
  readonly numero: number;
  readonly nombre: string;
  /** Sale de FilaPunto, que a su vez sale de computeCompliance. No se recalcula. */
  readonly omitido: boolean;
  readonly esCritico: boolean;
}

export interface MarcaEscaneoMapa extends PosicionMapa {
  /** Numero del punto en la ronda, o null si el escaneo no es de un punto esperado. */
  readonly numeroPunto: number | null;
  readonly anomalias: readonly ScanAnomaly[];
  /** Metros entre donde se marco y donde esta el punto; null si el punto no tiene coordenada. */
  readonly desviacionM: number | null;
}

export interface PuntoTrazaMapa extends PosicionMapa {
  readonly instante: Date;
}

/** Caja del encuadre en metros locales. Los lados nunca son cero. */
export interface EncuadreMapa {
  readonly esteMin: number;
  readonly esteMax: number;
  readonly norteMin: number;
  readonly norteMax: number;
}

export interface PuntoSinCoordenada {
  readonly numero: number;
  readonly nombre: string;
}

export interface MapaRecorrido {
  /** false = no hay una sola coordenada con que dibujar. El informe lo dice, no lo esconde. */
  readonly hayDatos: boolean;
  /** El tenant no exige compartir ubicacion: explica una traza vacia sin culpar al guardia. */
  readonly trazaDesactivada: boolean;
  readonly origen: Coordenada | null;
  readonly encuadre: EncuadreMapa;
  readonly puntos: readonly MarcaPuntoMapa[];
  /** Puntos esperados que no tienen coordenada cargada: no se pueden dibujar. */
  readonly puntosSinCoordenada: readonly PuntoSinCoordenada[];
  readonly traza: readonly PuntoTrazaMapa[];
  readonly escaneosDesviados: readonly MarcaEscaneoMapa[];
  /**
   * Escaneos con anomalia de GPS cuya posicion esta tan lejos que dibujarla
   * dejaria el recinto reducido a un punto. No se pierden: se cuentan y se
   * explican al pie del plano.
   */
  readonly escaneosFueraDelPlano: readonly MarcaEscaneoMapa[];
  /** Escaneos con anomalia de GPS que ni siquiera dejaron posicion (sin_fix_gps). */
  readonly escaneosGpsSinPosicion: number;
  /** Posiciones descartadas del dibujo por error GPS sobre el maximo del tenant. */
  readonly trazaDescartadaPorError: number;
  /** true cuando se dibuja una de cada N posiciones por el tope configurado. */
  readonly trazaSubmuestreada: boolean;
  /** Posiciones guardadas para esta ronda, antes de filtrar y submuestrear. */
  readonly trazaTotalRegistrada: number;
  /**
   * Distancia total del recorrido, en metros.
   *
   * Se calcula sobre TODAS las posiciones guardadas —incluidas las imprecisas
   * que no se dibujan— porque es el mismo numero que muestra el panel en vivo
   * (GeoService.patrolTrack). Un informe que diga 800 m y un panel que diga
   * 1.200 m para la misma ronda es una discusion con el cliente, no un detalle.
   */
  readonly distanciaTrazaM: number;
}

export interface EntradaMapa {
  /** Puntos de la ronda YA resueltos por el informe: el orden y el omitido vienen de ahi. */
  readonly puntos: readonly FilaPunto[];
  readonly coordenadas: readonly CoordenadaPuntoRow[];
  readonly traza: readonly TrazaRow[];
  readonly escaneos: readonly EscaneoGpsRow[];
  readonly recinto?: RecintoCoordRow | null;
  /** Error GPS maximo aceptado para dibujar una posicion (regla del tenant). */
  readonly maxErrorTrazaM: number;
  /** Tope de posiciones dibujadas (regla del tenant). */
  readonly maxPuntosTraza: number;
  /**
   * `gpsTrackingEnabled` del tenant: apagado no se guardo ni un punto, asi que
   * no hay traza que dibujar.
   *
   * NO es `gpsSharingMandatory`: esa regla decide obligatorio vs OPCIONAL, y en
   * modo opcional se registra igual el recorrido de quien acepto. Este
   * comentario decia lo contrario y quien lo leyera creeria que un PDF sin
   * trayecto se explica por tener el GPS en opcional. Lo que alimenta el campo
   * es `reglas.gpsTrackingEnabled` (mapa-recorrido.service.ts).
   */
  readonly trazaActivada: boolean;
  readonly spanMinimoM?: number;
}

/**
 * Arma el modelo del mapa.
 *
 * Regla de consistencia: el estado de cada punto NO se recalcula aca. Se toma
 * de FilaPunto, que ya salio de computeCompliance() en patrol-report.model. Si
 * el mapa contara sus propios omitidos, tarde o temprano el circulo y la tabla
 * de la pagina anterior dirian cosas distintas de la misma ronda.
 */
export function construirMapaRecorrido(entrada: EntradaMapa): MapaRecorrido {
  const {
    puntos,
    coordenadas,
    traza,
    escaneos,
    recinto = null,
    maxErrorTrazaM,
    maxPuntosTraza,
    trazaActivada,
    spanMinimoM = SPAN_MINIMO_M,
  } = entrada;

  const coordPorPunto = new Map<string, Coordenada>();
  for (const fila of coordenadas) {
    const punto = aCoordenada(fila.latitude, fila.longitude);
    if (punto) coordPorPunto.set(fila.id, punto);
  }

  const puntosConCoord: Array<{ fila: FilaPunto; coord: Coordenada }> = [];
  const puntosSinCoordenada: PuntoSinCoordenada[] = [];
  for (const fila of puntos) {
    const coord = coordPorPunto.get(fila.checkpointId);
    if (coord) puntosConCoord.push({ fila, coord });
    else puntosSinCoordenada.push({ numero: fila.numero, nombre: fila.nombre });
  }

  // Traza: primero se separan las posiciones utiles de las que el telefono
  // entrego con un error mayor al que el tenant acepta. Una posicion con 2 km
  // de error no es un dato malo, es ruido: dibujarla estira el encuadre y
  // aplasta el recorrido real hasta volverlo ilegible.
  const trazaValida: Array<{ coord: Coordenada; instante: Date }> = [];
  let trazaDescartadaPorError = 0;
  for (const fila of traza) {
    const coord = aCoordenada(fila.latitude, fila.longitude);
    if (!coord) continue;
    const error = aNumero(fila.accuracy_m);
    if (error !== null && error > maxErrorTrazaM) {
      trazaDescartadaPorError += 1;
      continue;
    }
    trazaValida.push({ coord, instante: fila.recorded_at_device });
  }

  const trazaDibujable = submuestrear(trazaValida, maxPuntosTraza);

  // Escaneos con anomalia de posicion. Los que no dejaron coordenada se cuentan
  // aparte: "no se sabe donde estaba" es informacion, y borrarla del informe
  // seria justo lo contrario de lo que pide el issue.
  const desviados: Array<{
    coord: Coordenada;
    numeroPunto: number | null;
    anomalias: readonly ScanAnomaly[];
    desviacionM: number | null;
  }> = [];
  let escaneosGpsSinPosicion = 0;
  const numeroPorPunto = new Map(puntos.map((fila) => [fila.checkpointId, fila.numero]));
  for (const escaneo of escaneos) {
    const anomalias = (escaneo.anomalies ?? []).filter((marca) => ANOMALIAS_GPS.includes(marca));
    if (anomalias.length === 0) continue;
    const coord = aCoordenada(escaneo.latitude, escaneo.longitude);
    if (!coord) {
      escaneosGpsSinPosicion += 1;
      continue;
    }
    const puntoCoord = coordPorPunto.get(escaneo.checkpoint_id);
    desviados.push({
      coord,
      numeroPunto: numeroPorPunto.get(escaneo.checkpoint_id) ?? null,
      anomalias,
      desviacionM: puntoCoord
        ? redondear(haversineM(coord.lat, coord.lng, puntoCoord.lat, puntoCoord.lng))
        : null,
    });
  }

  // El recinto lo definen los puntos y el recorrido, NO los escaneos con GPS
  // malo: son ellos los que tienen que caber en el plano, y no al reves.
  const baseGeografica: Coordenada[] = [
    ...puntosConCoord.map((p) => p.coord),
    ...trazaDibujable.map((p) => p.coord),
  ];
  const geograficas =
    baseGeografica.length > 0 ? baseGeografica : desviados.map((d) => d.coord);

  const distanciaTrazaM = redondear(distanciaDe(trazaTotalValida(traza)));

  if (geograficas.length === 0) {
    // Ni un punto, ni una posicion, ni un escaneo ubicado. Se devuelve el
    // modelo igual —con hayDatos en false— para que el informe explique por que
    // no hay mapa en vez de saltarse la seccion en silencio.
    return {
      hayDatos: false,
      trazaDesactivada: !trazaActivada,
      origen: aCoordenada(recinto?.latitude ?? null, recinto?.longitude ?? null),
      encuadre: encuadreDe([], spanMinimoM),
      puntos: [],
      puntosSinCoordenada,
      traza: [],
      escaneosDesviados: [],
      escaneosFueraDelPlano: [],
      escaneosGpsSinPosicion,
      trazaDescartadaPorError,
      trazaSubmuestreada: false,
      trazaTotalRegistrada: traza.length,
      distanciaTrazaM,
    };
  }

  const origen = centroGeografico(geograficas);
  const marcasPunto: MarcaPuntoMapa[] = puntosConCoord.map(({ fila, coord }) => ({
    ...proyectar(coord.lat, coord.lng, origen),
    numero: fila.numero,
    nombre: fila.nombre,
    omitido: fila.omitido,
    esCritico: fila.esCritico,
  }));
  const marcasTraza: PuntoTrazaMapa[] = trazaDibujable.map(({ coord, instante }) => ({
    ...proyectar(coord.lat, coord.lng, origen),
    instante,
  }));
  const marcasEscaneo: MarcaEscaneoMapa[] = desviados.map((d) => ({
    ...proyectar(d.coord.lat, d.coord.lng, origen),
    numeroPunto: d.numeroPunto,
    anomalias: d.anomalias,
    desviacionM: d.desviacionM,
  }));

  // Se separa lo que cabe de lo que no contra el encuadre del recinto. Cuando
  // NO hay recinto que dibujar —ni puntos ni recorrido—, los escaneos son lo
  // unico que hay y todos entran: ahi no hay nada que puedan aplastar.
  const base: PosicionMapa[] = [...marcasPunto, ...marcasTraza];
  const encuadreDelRecinto = encuadreDe(base, spanMinimoM);
  const dentro =
    base.length > 0
      ? marcasEscaneo.filter((marca) => cabeEnElPlano(marca, encuadreDelRecinto))
      : marcasEscaneo;
  const fuera = marcasEscaneo.filter((marca) => !dentro.includes(marca));

  return {
    hayDatos: true,
    trazaDesactivada: !trazaActivada,
    origen,
    encuadre: encuadreDe([...base, ...dentro], spanMinimoM),
    puntos: marcasPunto,
    puntosSinCoordenada,
    traza: marcasTraza,
    escaneosDesviados: dentro,
    escaneosFueraDelPlano: fuera,
    escaneosGpsSinPosicion,
    trazaDescartadaPorError,
    trazaSubmuestreada: trazaDibujable.length < trazaValida.length,
    trazaTotalRegistrada: traza.length,
    distanciaTrazaM,
  };
}

/** ¿Esta marca cabe en un plano de este recinto sin volverlo ilegible? */
function cabeEnElPlano(posicion: PosicionMapa, encuadre: EncuadreMapa): boolean {
  const centroEste = (encuadre.esteMin + encuadre.esteMax) / 2;
  const centroNorte = (encuadre.norteMin + encuadre.norteMax) / 2;
  const alcance =
    (Math.max(encuadre.esteMax - encuadre.esteMin, encuadre.norteMax - encuadre.norteMin) *
      ALCANCE_ESCANEO_DESVIADO) /
    2;
  return (
    Math.abs(posicion.este - centroEste) <= alcance &&
    Math.abs(posicion.norte - centroNorte) <= alcance
  );
}

// -------------------------------------------------------------- proyeccion

/**
 * Proyeccion equirectangular local: metros al este y al norte del origen.
 *
 * No es Web Mercator y no hace falta que lo sea. Un recinto mide cientos de
 * metros: a esa escala la deformacion de esta proyeccion esta por debajo del
 * error del propio GPS, y a cambio las distancias del dibujo son metros de
 * verdad — que es lo que permite poner una barra de escala honesta.
 */
export function proyectar(lat: number, lng: number, origen: Coordenada): PosicionMapa {
  const rad = (valor: number) => (valor * Math.PI) / 180;
  // Normaliza el salto del antimeridiano: sin esto una diferencia de 359.9
  // grados se dibujaria como media vuelta al mundo.
  let deltaLng = lng - origen.lng;
  if (deltaLng > 180) deltaLng -= 360;
  else if (deltaLng < -180) deltaLng += 360;
  return {
    este: RADIO_TIERRA_M * rad(deltaLng) * Math.cos(rad(origen.lat)),
    norte: RADIO_TIERRA_M * rad(lat - origen.lat),
  };
}

/** Centro de la caja que contiene todo. Es el origen de la proyeccion. */
function centroGeografico(coordenadas: readonly Coordenada[]): Coordenada {
  const lats = coordenadas.map((c) => c.lat);
  const lngs = coordenadas.map((c) => c.lng);
  return {
    lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
  };
}

/**
 * Encuadre cuadrado-minimo alrededor del contenido.
 *
 * Los lados NUNCA quedan en cero: un solo punto —o todos los puntos en el mismo
 * lugar— daria un lado de cero metros y la escala se iria a infinito. De ahi
 * sale `spanMinimo`.
 */
export function encuadreDe(
  posiciones: readonly PosicionMapa[],
  spanMinimo: number = SPAN_MINIMO_M,
): EncuadreMapa {
  const piso = Math.max(spanMinimo, 1);
  if (posiciones.length === 0) {
    return { esteMin: -piso / 2, esteMax: piso / 2, norteMin: -piso / 2, norteMax: piso / 2 };
  }
  const estes = posiciones.map((p) => p.este);
  const nortes = posiciones.map((p) => p.norte);
  const [esteMin, esteMax] = ladoConAire(Math.min(...estes), Math.max(...estes), piso);
  const [norteMin, norteMax] = ladoConAire(Math.min(...nortes), Math.max(...nortes), piso);
  return { esteMin, esteMax, norteMin, norteMax };
}

function ladoConAire(minimo: number, maximo: number, piso: number): [number, number] {
  const centro = (minimo + maximo) / 2;
  const largo = Math.max((maximo - minimo) * (1 + 2 * MARGEN_ENCUADRE), piso);
  return [centro - largo / 2, centro + largo / 2];
}

// ---------------------------------------------------------- ajuste a la hoja

export interface CajaDibujo {
  readonly x: number;
  readonly y: number;
  readonly ancho: number;
  readonly alto: number;
}

export interface AjusteMapa {
  /** Puntos PDF por metro. Siempre mayor que cero. */
  readonly escala: number;
  /** x del borde OESTE del contenido, ya centrado dentro de la caja. */
  readonly x0: number;
  /** y del borde NORTE del contenido, ya centrado dentro de la caja. */
  readonly y0: number;
  readonly esteMin: number;
  readonly norteMax: number;
  readonly anchoPx: number;
  readonly altoPx: number;
}

/**
 * Mete el encuadre dentro de la caja de la hoja CONSERVANDO LA PROPORCION.
 *
 * Estirar para llenar la caja seria mentir: 100 m a lo ancho y 100 m a lo alto
 * tienen que medir lo mismo en el papel, o la barra de escala deja de valer y
 * dos puntos igual de lejos se ven a distancias distintas.
 */
export function ajustarACaja(encuadre: EncuadreMapa, caja: CajaDibujo): AjusteMapa {
  const anchoM = Math.max(encuadre.esteMax - encuadre.esteMin, 1e-6);
  const altoM = Math.max(encuadre.norteMax - encuadre.norteMin, 1e-6);
  const escala = Math.max(
    Math.min(caja.ancho / anchoM, caja.alto / altoM),
    1e-6,
  );
  const anchoPx = anchoM * escala;
  const altoPx = altoM * escala;
  return {
    escala,
    x0: caja.x + (caja.ancho - anchoPx) / 2,
    y0: caja.y + (caja.alto - altoPx) / 2,
    esteMin: encuadre.esteMin,
    norteMax: encuadre.norteMax,
    anchoPx,
    altoPx,
  };
}

/** Metros locales -> coordenadas de la hoja. El norte queda arriba. */
export function enPdf(ajuste: AjusteMapa, posicion: PosicionMapa): { x: number; y: number } {
  return {
    x: ajuste.x0 + (posicion.este - ajuste.esteMin) * ajuste.escala,
    y: ajuste.y0 + (ajuste.norteMax - posicion.norte) * ajuste.escala,
  };
}

/**
 * Largo "redondo" para la barra de escala: 1, 2 o 5 por una potencia de diez.
 *
 * Una barra que dijera "37 m" es correcta y no sirve: nadie estima distancias
 * contra 37.
 */
export function barraEscala(
  anchoCajaPx: number,
  escala: number,
): { metros: number; px: number } {
  const objetivoM = (anchoCajaPx * 0.28) / escala;
  if (!Number.isFinite(objetivoM) || objetivoM <= 0) return { metros: 1, px: escala };
  const magnitud = 10 ** Math.floor(Math.log10(objetivoM));
  let elegido = magnitud;
  for (const factor of [1, 2, 5, 10]) {
    if (factor * magnitud <= objetivoM) elegido = factor * magnitud;
  }
  return { metros: elegido, px: elegido * escala };
}

// -------------------------------------------------------------------- apoyo

/** numeric llega como string desde el driver de postgres. */
function aNumero(valor: string | number | null): number | null {
  if (valor === null || valor === undefined) return null;
  const numero = typeof valor === 'number' ? valor : Number(valor);
  return Number.isFinite(numero) ? numero : null;
}

function aCoordenada(latitud: string | null, longitud: string | null): Coordenada | null {
  const lat = aNumero(latitud);
  const lng = aNumero(longitud);
  if (lat === null || lng === null) return null;
  // Una fila fuera de rango solo puede venir de una escritura a mano: se ignora
  // en vez de deformar el encuadre de todo el mapa.
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

function trazaTotalValida(traza: readonly TrazaRow[]): Coordenada[] {
  const salida: Coordenada[] = [];
  for (const fila of traza) {
    const coord = aCoordenada(fila.latitude, fila.longitude);
    if (coord) salida.push(coord);
  }
  return salida;
}

function distanciaDe(coordenadas: readonly Coordenada[]): number {
  let total = 0;
  for (let i = 1; i < coordenadas.length; i += 1) {
    const previo = coordenadas[i - 1]!;
    const actual = coordenadas[i]!;
    total += haversineM(previo.lat, previo.lng, actual.lat, actual.lng);
  }
  return total;
}

/**
 * Deja como maximo `maximo` posiciones, conservando SIEMPRE la primera y la
 * ultima. Una ronda offline de ocho horas puede sincronizar miles de puntos, y
 * dibujarlos todos en 250 puntos de alto no agrega informacion: agrega tinta.
 */
function submuestrear<T>(posiciones: readonly T[], maximo: number): readonly T[] {
  const techo = Math.max(2, Math.floor(maximo));
  if (posiciones.length <= techo) return posiciones;
  const paso = Math.ceil(posiciones.length / techo);
  const salida: T[] = [];
  for (let i = 0; i < posiciones.length; i += paso) salida.push(posiciones[i]!);
  const ultimo = posiciones[posiciones.length - 1]!;
  if (salida[salida.length - 1] !== ultimo) salida.push(ultimo);
  return salida;
}

/** Un decimal: la traza tiene precision de metros, no de centimetros. */
function redondear(valor: number): number {
  return Math.round(valor * 10) / 10;
}
