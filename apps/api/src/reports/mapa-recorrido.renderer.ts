import type { FondoCartografico } from './mapa-tiles';
import {
  ajustarACaja,
  expandirAProporcion,
  barraEscala,
  enPdf,
  type AjusteMapa,
  type MapaRecorrido,
  type MarcaEscaneoMapa,
  type MarcaPuntoMapa,
} from './mapa-recorrido.model';
import {
  PALETA,
  anchoUtil,
  asegurarEspacio,
  dibujarTituloSeccion,
  recortar,
} from './pdf-primitivas';

/**
 * Dibujo del mapa del recorrido dentro del informe de ronda (#79).
 *
 * ---------------------------------------------------------------------------
 * SE IMPRIME EN BLANCO Y NEGRO. EL COLOR NUNCA ES EL UNICO DATO.
 * ---------------------------------------------------------------------------
 * El informe se imprime, se fotocopia y se archiva. Un punto omitido pintado de
 * rojo, en una impresora laser en blanco y negro, es un punto gris al lado de
 * otro punto gris. Por eso cada estado se dibuja con varias senales a la vez:
 *
 *   Punto marcado   circulo RELLENO negro, numero en blanco, borde continuo.
 *   Punto OMITIDO   circulo VACIO, borde grueso PUNTEADO, numero en negro y un
 *                   aspa arriba a la derecha.
 *   Escaneo con
 *   anomalia GPS    rombo vacio en la posicion real que reporto el telefono,
 *                   unido con linea punteada al punto que estaba marcando.
 *
 * Relleno contra vacio, continuo contra punteado, circulo contra rombo, y un
 * aspa encima: cualquiera de las cuatro alcanza para distinguirlos sin color.
 * El rojo va como refuerzo para quien lo lea en pantalla, no como portador del
 * sentido.
 *
 * Los numeros son los MISMOS de la tabla "Puntos de la ronda". El mapa no
 * repite los nombres: en un plano de 250 puntos de alto, ocho nombres de punto
 * se pisan entre si y no se lee ninguno.
 *
 * ---------------------------------------------------------------------------
 * DETALLE DE PDF QUE NO SE VE HASTA QUE UN VISOR SE QUEJA
 * ---------------------------------------------------------------------------
 * El estado grafico (grosor de linea, patron de puntos) se fija ANTES de
 * construir el trazado, nunca entre el trazado y el pintado. Un operador `w` o
 * `d` en medio de un objeto de trazado es invalido segun la especificacion de
 * PDF: Acrobat lo perdona, otros visores no, y el error no aparece al generar
 * sino al abrir el archivo en la maquina del cliente.
 * ---------------------------------------------------------------------------
 */

/** Alto de la caja del plano. Entra completa en media hoja A4 con su leyenda. */
const ALTO_MAPA = 250;
/** Lo que consume dibujarTituloSeccion: su propio margen mas la linea de texto. */
const ALTO_TITULO = 40;
const ALTO_LEYENDA = 34;
const ALTO_NOTA = 10;

/** Aire entre el marco y el contenido: el radio de una marca mas un respiro. */
const PADDING_CAJA = 22;

const RADIO_MARCA = 8.5;
const RADIO_ROMBO = 6;

/** Flechas de sentido sobre el trazado. Tres alcanzan para leer hacia donde iba. */
const FLECHAS_DIRECCION = 3;
const LARGO_MINIMO_FLECHA = 8;

const BLANCO = '#ffffff';

interface Punto2D {
  readonly x: number;
  readonly y: number;
}

interface CajaPlano {
  readonly x: number;
  readonly y: number;
  readonly ancho: number;
  readonly alto: number;
}

/**
 * Dibuja la seccion completa: titulo, plano, leyenda y notas al pie.
 *
 * Reserva el alto ANTES de escribir el titulo. Si se reservara despues, un mapa
 * que no cabe empujaria la caja a la hoja siguiente y dejaria el titulo solo al
 * final de la anterior.
 */
export function dibujarMapaRecorrido(
  doc: PDFKit.PDFDocument,
  mapa: MapaRecorrido,
  fondo: FondoCartografico | null = null,
): void {
  const notas = armarNotas(mapa, fondo);
  // Las notas pueden ocupar mas de un renglon; se reserva con holgura.
  asegurarEspacio(doc, ALTO_TITULO + ALTO_RESUMEN_TRAZA + ALTO_MAPA + ALTO_LEYENDA + notas.length * ALTO_NOTA * 2 + 12);
  dibujarTituloSeccion(doc, 'Mapa del recorrido');

  const x0 = doc.page.margins.left;

  // Las cifras van ARRIBA del plano: quien hojea el informe lee primero cuanto
  // se recorrio y en cuanto tiempo, y despues mira por donde.
  const altoResumen = dibujarResumenTraza(doc, mapa, {
    x: x0,
    y: doc.y,
    ancho: anchoUtil(doc),
  });

  const caja: CajaPlano = {
    x: x0,
    y: doc.y + altoResumen,
    ancho: anchoUtil(doc),
    alto: ALTO_MAPA,
  };

  doc.save();
  doc.lineWidth(0.8);
  doc.rect(caja.x, caja.y, caja.ancho, caja.alto).fillAndStroke(BLANCO, PALETA.linea);


  if (mapa.hayDatos) {
    const interior = {
      x: caja.x + PADDING_CAJA,
      y: caja.y + PADDING_CAJA,
      ancho: caja.ancho - PADDING_CAJA * 2,
      alto: caja.alto - PADDING_CAJA * 2,
    };
    // Se estira el encuadre a la proporcion de la caja para no dejar dos
    // tercios de la hoja en blanco. Tiene que ser el MISMO calculo que hace el
    // servicio al pedir los tiles, o el fondo queda corrido.
    const encuadre = expandirAProporcion(mapa.encuadre, interior);
    const ajuste = ajustarACaja(encuadre, interior);

    // La cartografia va PRIMERO —es fondo— y en el MISMO rectangulo que ocupa
    // el plano: `ajuste.x0/y0/anchoPx/altoPx`, no la caja entera. Dibujarla en
    // la caja completa fue el error anterior: el encuadre es cuadrado y la caja
    // apaisada, asi que las calles quedaban corridas respecto del recorrido.
    if (fondo && fondo.tiles.length > 0) {
      doc.save();
      // El recorte impide que un tile se derrame sobre la leyenda de abajo.
      doc.rect(ajuste.x0, ajuste.y0, ajuste.anchoPx, ajuste.altoPx).clip();
      for (const tile of fondo.tiles) {
        try {
          doc.image(tile.datos, ajuste.x0 + tile.x, ajuste.y0 + tile.y, {
            width: tile.tam,
            height: tile.tam,
          });
        } catch {
          // Un tile ilegible no puede tumbar el informe entero.
        }
      }
      // Velo blanco: baja el contraste del mapa para que el recorrido resalte.
      doc.rect(ajuste.x0, ajuste.y0, ajuste.anchoPx, ajuste.altoPx).fillOpacity(0.3).fill(BLANCO);
      doc.fillOpacity(1);
      doc.restore();
      doc.rect(ajuste.x0, ajuste.y0, ajuste.anchoPx, ajuste.altoPx).stroke(PALETA.linea);
    }

    // Orden de capas: primero el trazado, despues los escaneos desviados y al
    // final los puntos. Asi una marca de punto nunca queda tapada por la linea.
    dibujarTraza(doc, mapa, ajuste);
    for (const escaneo of mapa.escaneosDesviados) {
      dibujarEscaneoDesviado(doc, mapa, escaneo, ajuste);
    }
    for (const punto of mapa.puntos) dibujarPunto(doc, punto, ajuste);

    dibujarNorte(doc, caja);
    dibujarBarraEscala(doc, caja, ajuste);
  } else {
    dibujarSinDatos(doc, caja, mapa);
  }
  doc.restore();

  // El dibujo movio el cursor de pdfkit a coordenadas arbitrarias (cada numero
  // dentro de un circulo es un doc.text): se reposiciona a mano bajo la caja.
  doc.x = x0;
  doc.y = caja.y + caja.alto + 8;
  dibujarLeyenda(doc, x0, caja.ancho);
  for (const nota of notas) {
    // doc.text avanza el cursor por su cuenta: se fija la posicion de la nota
    // siguiente a mano, o el interlineado real termina siendo el doble del que
    // se reservo y la ultima nota se cae de la hoja.
    //
    // El alto se MIDE y no se asume: dar por hecho una linea por nota hacia que
    // una nota larga se dibujara encima de la siguiente. Se veia como texto
    // pisado en el informe, sin ningun error de por medio.
    const y = doc.y;
    doc.font('Helvetica').fontSize(7.5).fillColor(PALETA.gris);
    const alto = doc.heightOfString(nota, { width: caja.ancho });
    doc.text(nota, x0, y, { width: caja.ancho });
    doc.y = y + Math.max(alto, ALTO_NOTA);
  }
  doc.x = x0;
  doc.y += 4;
}

// -------------------------------------------------------------------- capas

/**
 * Radio del punto que marca UNA posicion medida, segun cuantas haya.
 *
 * Tiene que SUPERAR el medio ancho de la linea (1,3 pt de grosor, o sea 0,65
 * de radio) o el punto queda enterrado debajo del trazo y no se ve: eso paso
 * con el primer valor que probe, 1,1 pt, que en el PDF no se distinguia.
 *
 * Y no puede ser fijo: una ronda corta trae veinte posiciones muy separadas y
 * otra larga trae quinientas pegadas. El mismo radio que se lee bien en la
 * primera convierte a la segunda en una salchicha. Se achica cuando hay
 * muchas, que es justo cuando la densidad ya se ve sola.
 */
function radioPosicion(cantidad: number): number {
  if (cantidad > 300) return 1.1;
  if (cantidad > 120) return 1.5;
  return 1.9;
}

/**
 * Cuantas posiciones justifican dibujarlas una por una.
 *
 * Con dos o tres puntos la nube no dice nada que la linea no diga: solo
 * ensucia. Lo que se quiere mostrar es muestreo sostenido.
 */
const MINIMO_PARA_PUNTEAR = 8;

/**
 * Cifras del recorrido, arriba del plano.
 *
 * Lo que el mapa muestra pero no dice: cuanto camino, cuanto duro y cuanto de
 * eso estuvo quieto. Sin esos tres numeros, dos planos identicos pueden ser una
 * ronda de veinte minutos y otra de tres horas.
 *
 * Todo sale de la traza que ya esta en el modelo —la distancia la calcula el
 * modelo y las horas vienen en cada posicion—, asi que no cuesta una consulta
 * nueva ni depende de que el resumen de metricas este disponible.
 */
/** Alto de la banda de cifras. Reservado tambien por `asegurarEspacio`. */
const ALTO_RESUMEN_TRAZA = 30;

function dibujarResumenTraza(
  doc: PDFKit.PDFDocument,
  mapa: MapaRecorrido,
  caja: { x: number; y: number; ancho: number },
): number {
  if (!mapa.hayDatos || mapa.traza.length < 2) return 0;

  const primero = mapa.traza[0]!;
  const ultimo = mapa.traza[mapa.traza.length - 1]!;
  const minutos = (ultimo.instante.getTime() - primero.instante.getTime()) / 60_000;
  if (!Number.isFinite(minutos) || minutos <= 0) return 0;

  const celdas: Array<{ rotulo: string; valor: string }> = [
    { rotulo: 'RECORRIDO', valor: formatearDistancia(mapa.distanciaTrazaM) },
    { rotulo: 'DURACIÓN', valor: `${formatearEntero(Math.round(minutos))} min` },
    { rotulo: 'POSICIONES', valor: formatearEntero(mapa.trazaTotalRegistrada) },
    {
      rotulo: 'RITMO MEDIO',
      valor: `${(mapa.distanciaTrazaM / 1000 / (minutos / 60)).toFixed(1)} km/h`,
    },
  ];

  const anchoCelda = caja.ancho / celdas.length;
  doc.save();
  doc.lineWidth(0.6).rect(caja.x, caja.y, caja.ancho, ALTO_RESUMEN_TRAZA).fillAndStroke(BLANCO, PALETA.linea);
  celdas.forEach((celda, i) => {
    const x = caja.x + anchoCelda * i + 8;
    // Separador entre celdas, salvo antes de la primera.
    if (i > 0) {
      doc.moveTo(caja.x + anchoCelda * i, caja.y + 5)
        .lineTo(caja.x + anchoCelda * i, caja.y + ALTO_RESUMEN_TRAZA - 5)
        .stroke(PALETA.linea);
    }
    doc.font('Helvetica').fontSize(5.6).fillColor(PALETA.gris);
    doc.text(celda.rotulo, x, caja.y + 6, { width: anchoCelda - 16 });
    doc.font('Helvetica-Bold').fontSize(9.5).fillColor(PALETA.tinta);
    doc.text(celda.valor, x, caja.y + 14, { width: anchoCelda - 16 });
  });
  doc.restore();
  return ALTO_RESUMEN_TRAZA + 8;
}

function dibujarTraza(doc: PDFKit.PDFDocument, mapa: MapaRecorrido, ajuste: AjusteMapa): void {
  const puntos = mapa.traza.map((posicion) => enPdf(ajuste, posicion));
  if (puntos.length === 0) return;

  const primero = puntos[0]!;
  if (puntos.length > 1) {
    doc.save();
    doc.lineWidth(1.3).lineJoin('round').strokeColor(PALETA.gris);
    doc.moveTo(primero.x, primero.y);
    for (let i = 1; i < puntos.length; i += 1) {
      const siguiente = puntos[i]!;
      doc.lineTo(siguiente.x, siguiente.y);
    }
    doc.stroke();
    doc.restore();
    dibujarFlechasDeSentido(doc, puntos);

    /*
     * Y encima de la linea, CADA POSICION MEDIDA.
     *
     * Una linea entre dos marcas puede ser cualquier cosa: el dibujo no
     * distingue un recorrido muestreado cada 15 segundos de una recta trazada
     * entre el primer y el ultimo escaneo. Quien recibe el informe no tiene
     * como saber cual de las dos esta mirando, y esa ambiguedad juega en contra
     * de lo unico que el producto vende, que es evidencia.
     *
     * Los puntos deshacen la ambiguedad sin explicar nada: donde hubo muestreo
     * hay puntos, y donde la linea cruza sola es porque ahi no se midio.
     */
    if (puntos.length >= MINIMO_PARA_PUNTEAR) {
      // En tinta y no en gris: sobre una linea gris del mismo tono el punto
      // desaparece. El contraste es lo que separa "medido" de "interpolado".
      const radio = radioPosicion(puntos.length);
      doc.save();
      doc.fillColor(PALETA.tinta);
      for (const punto of puntos) {
        doc.circle(punto.x, punto.y, radio).fill();
      }
      doc.restore();
    }
  }

  // Inicio: triangulo relleno. Fin: cuadrado relleno. Formas distintas de las de
  // los puntos de control, para que nadie las confunda con un checkpoint.
  const ultimo = puntos[puntos.length - 1]!;
  dibujarTriangulo(doc, primero, 5, PALETA.tinta);
  doc.save();
  doc.rect(ultimo.x - 4, ultimo.y - 4, 8, 8).fill(PALETA.tinta);
  doc.restore();
}

/**
 * Flechas de sentido repartidas a lo largo del trazado.
 *
 * Sin ellas el plano dice por donde paso pero no en que orden, y "empezo por la
 * bodega y termino en porteria" es justamente lo que se revisa cuando se
 * sospecha de una ronda.
 */
function dibujarFlechasDeSentido(doc: PDFKit.PDFDocument, puntos: readonly Punto2D[]): void {
  if (puntos.length < 2) return;
  const usados = new Set<number>();
  for (let n = 1; n <= FLECHAS_DIRECCION; n += 1) {
    const objetivo = Math.max(1, Math.floor((puntos.length * n) / (FLECHAS_DIRECCION + 1)));
    const indice = elegirSegmento(puntos, objetivo, usados);
    if (indice === null) continue;
    usados.add(indice);
    dibujarFlecha(doc, puntos[indice - 1]!, puntos[indice]!);
  }
}

/** Busca cerca del indice pedido un segmento lo bastante largo para verse. */
function elegirSegmento(
  puntos: readonly Punto2D[],
  desde: number,
  usados: ReadonlySet<number>,
): number | null {
  for (let salto = 0; salto < puntos.length; salto += 1) {
    for (const indice of [desde + salto, desde - salto]) {
      if (indice < 1 || indice >= puntos.length || usados.has(indice)) continue;
      const a = puntos[indice - 1]!;
      const b = puntos[indice]!;
      if (Math.hypot(b.x - a.x, b.y - a.y) >= LARGO_MINIMO_FLECHA) return indice;
    }
  }
  return null;
}

function dibujarFlecha(doc: PDFKit.PDFDocument, desde: Punto2D, hasta: Punto2D): void {
  const angulo = Math.atan2(hasta.y - desde.y, hasta.x - desde.x);
  const cx = (desde.x + hasta.x) / 2;
  const cy = (desde.y + hasta.y) / 2;
  const largo = 4.5;
  const ancho = 2.6;
  const cos = Math.cos(angulo);
  const sen = Math.sin(angulo);
  doc.save();
  doc.polygon(
    [cx + cos * largo, cy + sen * largo],
    [cx - cos * largo * 0.5 - sen * ancho, cy - sen * largo * 0.5 + cos * ancho],
    [cx - cos * largo * 0.5 + sen * ancho, cy - sen * largo * 0.5 - cos * ancho],
  ).fill(PALETA.gris);
  doc.restore();
}

function dibujarPunto(doc: PDFKit.PDFDocument, punto: MarcaPuntoMapa, ajuste: AjusteMapa): void {
  const centro = enPdf(ajuste, punto);
  doc.save();
  if (punto.omitido) {
    doc.lineWidth(1.8).dash(2.4, { space: 1.8 });
    doc.circle(centro.x, centro.y, RADIO_MARCA).fillAndStroke(BLANCO, PALETA.alerta);
    doc.undash();
    dibujarAspa(doc, centro.x + RADIO_MARCA * 0.85, centro.y - RADIO_MARCA * 0.85);
    // El numero va en negro y no en rojo: en blanco y negro el rojo cae a un
    // gris medio y una cifra de 8 puntos en gris medio deja de leerse.
    escribirNumero(doc, centro, String(punto.numero), PALETA.tinta);
  } else {
    doc.lineWidth(0.8);
    doc.circle(centro.x, centro.y, RADIO_MARCA).fillAndStroke(PALETA.tinta, PALETA.tinta);
    escribirNumero(doc, centro, String(punto.numero), BLANCO);
  }
  doc.restore();
}

/** Aspa del punto omitido: la senal que sobrevive a una fotocopia. */
function dibujarAspa(doc: PDFKit.PDFDocument, x: number, y: number): void {
  const brazo = 3.2;
  doc.lineWidth(1.4).strokeColor(PALETA.alerta);
  doc.moveTo(x - brazo, y - brazo).lineTo(x + brazo, y + brazo).stroke();
  doc.moveTo(x - brazo, y + brazo).lineTo(x + brazo, y - brazo).stroke();
}

function escribirNumero(
  doc: PDFKit.PDFDocument,
  centro: Punto2D,
  texto: string,
  color: string,
): void {
  doc.font('Helvetica-Bold').fontSize(8).fillColor(color)
    .text(texto, centro.x - RADIO_MARCA, centro.y - 3.6, {
      width: RADIO_MARCA * 2,
      align: 'center',
      lineBreak: false,
    });
}

/**
 * Escaneo marcado con anomalia de GPS: rombo vacio donde el telefono dijo que
 * estaba, unido con linea punteada al punto que se estaba marcando.
 *
 * El sistema MARCA, no rechaza (ver CLAUDE.md): en un subterraneo el GPS se
 * equivoca por metros sin que nadie haya hecho nada malo. El informe muestra
 * donde ocurrio y quien decide es el supervisor.
 */
function dibujarEscaneoDesviado(
  doc: PDFKit.PDFDocument,
  mapa: MapaRecorrido,
  escaneo: MarcaEscaneoMapa,
  ajuste: AjusteMapa,
): void {
  const centro = enPdf(ajuste, escaneo);
  const punto = mapa.puntos.find((candidato) => candidato.numero === escaneo.numeroPunto);

  doc.save();
  if (punto) {
    const destino = enPdf(ajuste, punto);
    doc.lineWidth(0.8).dash(2, { space: 2 }).strokeColor(PALETA.alerta);
    doc.moveTo(centro.x, centro.y).lineTo(destino.x, destino.y).stroke();
    doc.undash();
  }
  doc.lineWidth(1.2);
  doc.polygon(
    [centro.x, centro.y - RADIO_ROMBO],
    [centro.x + RADIO_ROMBO, centro.y],
    [centro.x, centro.y + RADIO_ROMBO],
    [centro.x - RADIO_ROMBO, centro.y],
  ).fillAndStroke(BLANCO, PALETA.alerta);
  doc.restore();
}

// ---------------------------------------------------------- norte y escala

/** Sin norte ni escala esto no es un plano, es un dibujo. */
function dibujarNorte(doc: PDFKit.PDFDocument, caja: CajaPlano): void {
  const x = caja.x + caja.ancho - 18;
  const yBase = caja.y + 30;
  doc.save();
  doc.lineWidth(1).strokeColor(PALETA.tinta);
  doc.moveTo(x, yBase).lineTo(x, yBase - 14).stroke();
  doc.polygon([x, yBase - 20], [x - 3.4, yBase - 12], [x + 3.4, yBase - 12]).fill(PALETA.tinta);
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(PALETA.tinta)
    .text('N', x - 6, yBase + 2, { width: 12, align: 'center', lineBreak: false });
  doc.restore();
}

function dibujarBarraEscala(doc: PDFKit.PDFDocument, caja: CajaPlano, ajuste: AjusteMapa): void {
  const barra = barraEscala(caja.ancho - PADDING_CAJA * 2, ajuste.escala);
  const x = caja.x + 12;
  const y = caja.y + caja.alto - 16;
  doc.save();
  doc.lineWidth(1.4).strokeColor(PALETA.tinta);
  doc.moveTo(x, y).lineTo(x + barra.px, y).stroke();
  doc.lineWidth(1);
  doc.moveTo(x, y - 3).lineTo(x, y + 3).stroke();
  doc.moveTo(x + barra.px, y - 3).lineTo(x + barra.px, y + 3).stroke();
  doc.font('Helvetica').fontSize(7).fillColor(PALETA.gris)
    .text(formatearDistancia(barra.metros), x, y - 11, {
      width: Math.max(barra.px, 24),
      align: 'center',
      lineBreak: false,
    });
  doc.restore();
}

// ---------------------------------------------------------- leyenda y notas

interface ItemLeyenda {
  readonly dibujar: (doc: PDFKit.PDFDocument, x: number, y: number) => void;
  readonly texto: string;
}

const LEYENDA: readonly ItemLeyenda[] = [
  {
    texto: 'Punto marcado',
    dibujar: (doc, x, y) => {
      doc.lineWidth(0.8);
      doc.circle(x, y, 5).fillAndStroke(PALETA.tinta, PALETA.tinta);
    },
  },
  {
    texto: 'Punto OMITIDO',
    dibujar: (doc, x, y) => {
      doc.lineWidth(1.6).dash(2, { space: 1.6 });
      doc.circle(x, y, 5).fillAndStroke(BLANCO, PALETA.alerta);
      doc.undash();
    },
  },
  {
    texto: 'Escaneo con anomalía de GPS',
    dibujar: (doc, x, y) => {
      doc.lineWidth(1.2);
      doc.polygon([x, y - 5], [x + 5, y], [x, y + 5], [x - 5, y])
        .fillAndStroke(BLANCO, PALETA.alerta);
    },
  },
  {
    texto: 'Recorrido y sentido de la marcha',
    dibujar: (doc, x, y) => {
      doc.lineWidth(1.3).strokeColor(PALETA.gris);
      doc.moveTo(x - 6, y).lineTo(x + 6, y).stroke();
      doc.polygon([x + 6, y], [x + 1, y - 2.6], [x + 1, y + 2.6]).fill(PALETA.gris);
    },
  },
  {
    // Va JUNTO al recorrido y no al final de la lista: los dos hablan del mismo
    // trazo, y lo que hay que entender es que la linea une posiciones medidas.
    texto: 'Cada posición registrada',
    dibujar: (doc, x, y) => {
      doc.fillColor(PALETA.tinta);
      for (const dx of [-6, -2, 2, 6]) doc.circle(x + dx, y, 1.9).fill();
    },
  },
  {
    texto: 'Inicio del recorrido',
    dibujar: (doc, x, y) => {
      dibujarTriangulo(doc, { x, y }, 5, PALETA.tinta);
    },
  },
  {
    texto: 'Fin del recorrido',
    dibujar: (doc, x, y) => {
      doc.rect(x - 4, y - 4, 8, 8).fill(PALETA.tinta);
    },
  },
];

function dibujarLeyenda(doc: PDFKit.PDFDocument, x0: number, ancho: number): void {
  const columnas = 3;
  const anchoColumna = ancho / columnas;
  const yBase = doc.y;
  LEYENDA.forEach((item, indice) => {
    const columna = indice % columnas;
    const fila = Math.floor(indice / columnas);
    const x = x0 + columna * anchoColumna;
    const y = yBase + fila * 15;
    doc.save();
    item.dibujar(doc, x + 6, y + 5);
    doc.restore();
    doc.font('Helvetica').fontSize(7.5).fillColor(PALETA.tinta)
      .text(item.texto, x + 16, y + 1.5, { width: anchoColumna - 20, lineBreak: false });
  });
  doc.x = x0;
  doc.y = yBase + Math.ceil(LEYENDA.length / columnas) * 15 + 4;
}

/**
 * Notas al pie del plano.
 *
 * Todo lo que el mapa NO puede mostrar se dice con palabras: un mapa al que le
 * faltan puntos y no lo avisa se lee como un mapa completo, y esa es la peor
 * lectura posible — el jefe de operaciones concluiria que el guardia no paso
 * por donde en realidad si paso.
 */
export function armarNotas(mapa: MapaRecorrido, fondo: FondoCartografico | null = null): string[] {
  const notas: string[] = [];
  if (fondo) {
    // Obligatoria por la licencia ODbL: si se dibuja el mapa, se cita.
    notas.push(`Cartografía: ${fondo.atribucion}.`);
  }

  if (mapa.hayDatos) {
    notas.push(
      `Recorrido registrado: ${formatearDistancia(mapa.distanciaTrazaM)} · ` +
        `${formatearEntero(mapa.trazaTotalRegistrada)} posición(es) de GPS.`,
    );
  }

  // Un punto que la ronda incluye pero el plano no muestra tiene que decirse
  // con nombre y distancia. Si solo desapareciera, el supervisor leeria un mapa
  // incompleto creyendolo completo — que es peor que el mapa ilegible de antes.
  if (mapa.puntosFueraDelPlano.length > 0) {
    const nombres = mapa.puntosFueraDelPlano
      .slice(0, 3)
      .map((punto) => `${punto.numero}. ${recortar(punto.nombre, 18)} a ${formatearDistancia(punto.distanciaM)}`)
      .join(', ');
    const resto =
      mapa.puntosFueraDelPlano.length > 3 ? ` y ${mapa.puntosFueraDelPlano.length - 3} más` : '';
    notas.push(
      `${mapa.puntosFueraDelPlano.length} punto(s) en otra ubicación, fuera del plano: ${nombres}${resto}.`,
    );
  }

  if (mapa.puntosSinCoordenada.length > 0) {
    const nombres = mapa.puntosSinCoordenada
      .slice(0, 4)
      .map((punto) => `${punto.numero}. ${recortar(punto.nombre, 24)}`)
      .join(', ');
    const resto =
      mapa.puntosSinCoordenada.length > 4 ? ` y ${mapa.puntosSinCoordenada.length - 4} más` : '';
    notas.push(
      `No se dibujan ${mapa.puntosSinCoordenada.length} punto(s) sin coordenada cargada: ` +
        `${nombres}${resto}. Cárgalas en la ficha del punto de control.`,
    );
  }

  if (mapa.escaneosGpsSinPosicion > 0) {
    notas.push(
      `${mapa.escaneosGpsSinPosicion} escaneo(s) quedaron marcados sin señal de GPS: ` +
        'no tienen posición que dibujar y aparecen solo en la tabla de puntos.',
    );
  }

  if (mapa.escaneosFueraDelPlano.length > 0) {
    const distancias = mapa.escaneosFueraDelPlano
      .map((escaneo) => escaneo.desviacionM)
      .filter((valor): valor is number => valor !== null);
    const detalle =
      distancias.length > 0 ? ` (hasta ${formatearDistancia(Math.max(...distancias))} del punto)` : '';
    notas.push(
      `${mapa.escaneosFueraDelPlano.length} escaneo(s) con anomalía de GPS quedaron fuera del ` +
        `plano${detalle}: dibujarlos dejaría el recinto reducido a un punto.`,
    );
  }

  if (mapa.trazaDescartadaPorError > 0) {
    notas.push(
      `Se dejaron fuera del dibujo ${mapa.trazaDescartadaPorError} posición(es) con error de ` +
        'GPS sobre el máximo configurado. La distancia total sí las considera.',
    );
  }

  if (mapa.trazaSubmuestreada) {
    notas.push(
      'El recorrido se dibuja simplificado para que se lea; el detalle completo está en el ' +
        'seguimiento de la ronda en el panel.',
    );
  }

  if (mapa.trazaDesactivada) {
    notas.push(
      'Esta empresa no tiene activado el registro de recorrido: el plano muestra los puntos, ' +
        'no el trayecto entre ellos.',
    );
  }

  // Solo cuando NO hay cartografia: con fondo la frase seria falsa, y decirle
  // al supervisor que no hay mapa mientras mira uno es peor que no decir nada.
  if (!fondo) {
    notas.push(
      'Plano a escala sin cartografía de fondo: las distancias son reales, el entorno no se dibuja.',
    );
  }
  return notas;
}

function dibujarSinDatos(doc: PDFKit.PDFDocument, caja: CajaPlano, mapa: MapaRecorrido): void {
  const motivo = mapa.trazaDesactivada
    ? 'Esta empresa no tiene activado el registro de recorrido y los puntos de control todavía no tienen coordenadas cargadas.'
    : 'Ni los puntos de control ni esta ronda registraron coordenadas.';
  doc.font('Helvetica-Bold').fontSize(10).fillColor(PALETA.gris)
    .text('Sin datos de ubicación para dibujar el mapa', caja.x + 20, caja.y + caja.alto / 2 - 18, {
      width: caja.ancho - 40,
      align: 'center',
      lineBreak: false,
    });
  doc.font('Helvetica').fontSize(8.5).fillColor(PALETA.gris)
    .text(motivo, caja.x + 40, caja.y + caja.alto / 2 - 2, {
      width: caja.ancho - 80,
      align: 'center',
    });
}

// ------------------------------------------------------------------ formato

function dibujarTriangulo(
  doc: PDFKit.PDFDocument,
  centro: Punto2D,
  radio: number,
  color: string,
): void {
  doc.save();
  doc.polygon(
    [centro.x, centro.y - radio],
    [centro.x + radio * 0.9, centro.y + radio * 0.8],
    [centro.x - radio * 0.9, centro.y + radio * 0.8],
  ).fill(color);
  doc.restore();
}

/** Metros bajo el kilometro, kilometros con un decimal sobre el. */
export function formatearDistancia(metros: number): string {
  if (!Number.isFinite(metros) || metros < 0) return '—';
  if (metros < 1000) return `${formatearEntero(Math.round(metros))} m`;
  return `${(metros / 1000).toFixed(1).replace('.', ',')} km`;
}

function formatearEntero(valor: number): string {
  try {
    return new Intl.NumberFormat('es-CL').format(valor);
  } catch {
    return String(valor);
  }
}
