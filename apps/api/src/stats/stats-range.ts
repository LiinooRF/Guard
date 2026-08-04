import { BadRequestException } from '@nestjs/common';

/**
 * Rango de fechas de las graficas: siempre acotado, nunca abierto.
 *
 * "Desde el inicio de los tiempos" sobre un tenant con 40 recintos y dos años
 * de operacion no es una grafica, es un incidente: la consulta se lleva la
 * memoria del motor y de paso deja la transaccion del request abierta minutos.
 * Cada grafica declara su tope segun la tabla que toca.
 *
 * Estos topes NO son reglas de negocio (esas van a rules.ts y las edita el
 * admin): son limites operativos de proteccion de la base. Si algun dia un
 * cliente necesita un tope distinto al del producto, ahi si se mueven a
 * rules.ts como override por tenant.
 *
 * Las fechas son DIAS CALENDARIO ('YYYY-MM-DD'), no instantes. El dia se
 * resuelve contra la zona horaria del recinto dentro del SQL; mandar un
 * instante desde el navegador solo serviria para meter la zona del cliente en
 * el medio.
 */

/**
 * Series apoyadas en `patrol_daily_stats` (cumplimiento por recinto y
 * evolucion). El cubo diario tiene una fila por recinto y dia, asi que dos años
 * de un tenant grande son decenas de miles de filas: se sostiene.
 */
export const MAX_DIAS_SERIE = 731;

/**
 * Ranking de guardias: se agrega en vivo sobre `patrols` porque el umbral
 * vigente tiene que aplicarse en el momento de la consulta. Un año es lo que
 * cualquier evaluacion de desempeño necesita.
 */
export const MAX_DIAS_RANKING = 366;

/**
 * Puntos mas omitidos: cruza `patrols` con `scans`, la tabla mas grande del
 * producto. Un trimestre. Este es el tope que de verdad protege la base.
 */
export const MAX_DIAS_ESCANEOS = 92;

/** Sin parametros, el panel abre con el ultimo mes. */
export const DIAS_POR_DEFECTO = 30;

const FORMATO_DIA = /^\d{4}-\d{2}-\d{2}$/;
const MS_POR_DIA = 86_400_000;

export interface RangoDias {
  /** Primer dia incluido, 'YYYY-MM-DD'. */
  readonly desde: string;
  /** Ultimo dia incluido, 'YYYY-MM-DD'. */
  readonly hasta: string;
  /** Dias del rango, ambos extremos incluidos. */
  readonly dias: number;
}

function aFecha(valor: string, campo: string): Date {
  if (!FORMATO_DIA.test(valor)) {
    throw new BadRequestException(`\`${campo}\` debe ser una fecha con formato YYYY-MM-DD`);
  }
  const fecha = new Date(`${valor}T00:00:00.000Z`);
  if (Number.isNaN(fecha.getTime()) || aTexto(fecha) !== valor) {
    throw new BadRequestException(`\`${campo}\` no es una fecha valida`);
  }
  return fecha;
}

function aTexto(fecha: Date): string {
  return fecha.toISOString().slice(0, 10);
}

/**
 * Resuelve y valida el rango pedido contra el tope de la grafica.
 *
 * Se opera con instantes UTC de medianoche solo como aritmetica de calendario:
 * aca no hay conversion de zona horaria ninguna, y por eso no hay ningun dia de
 * cambio de horario que se pueda correr. La zona del recinto entra despues, en
 * el SQL.
 *
 * Sin `to` se usa hoy en UTC. Es deliberadamente el extremo mas ancho: para las
 * zonas al oeste de Greenwich —todas las de este producto— el dia UTC va por
 * delante del local, asi que a lo sumo se incluye un dia futuro vacio. Cortar
 * por el dia UTC anterior si podria esconder el dia en curso del recinto.
 */
export function resolverRango(
  from: string | undefined,
  to: string | undefined,
  maxDias: number,
): RangoDias {
  const hasta = to ? aFecha(to, 'to') : new Date(Date.now() - (Date.now() % MS_POR_DIA));
  const desde = from
    ? aFecha(from, 'from')
    : new Date(hasta.getTime() - (DIAS_POR_DEFECTO - 1) * MS_POR_DIA);

  if (desde.getTime() > hasta.getTime()) {
    throw new BadRequestException('`from` no puede ser posterior a `to`');
  }

  const dias = Math.round((hasta.getTime() - desde.getTime()) / MS_POR_DIA) + 1;
  if (dias > maxDias) {
    throw new BadRequestException(
      `El rango pedido es de ${dias} dias y el maximo de esta grafica es ${maxDias}. ` +
        'Acota el periodo o pide el informe en PDF.',
    );
  }

  return { desde: aTexto(desde), hasta: aTexto(hasta), dias };
}
