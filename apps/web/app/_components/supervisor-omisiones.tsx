/**
 * "Que puntos se omiten siempre" — tarjeta del supervisor (#99).
 *
 * Es el criterio de aceptacion literal del issue, y no lo cubre la tarjeta de
 * puntos omitidos del panel general (#87): aquella ordena por CANTIDAD de
 * omisiones, asi que un punto saltado 40 veces de 400 encabeza la lista por
 * encima de uno saltado 12 de 12. Para "se omite siempre" el orden util es por
 * porcentaje, con una muestra minima que evite que un punto esperado una sola
 * vez aparezca como el peor del recinto.
 *
 * Lo que este reorden NO puede hacer, y por eso se declara en pantalla: el
 * endpoint elige que puntos manda con `ORDER BY omitidos DESC ... LIMIT`, o sea
 * por cantidad ABSOLUTA de omisiones. Se le pide el maximo que acepta (50), pero
 * si la respuesta viene llena, un punto de baja frecuencia saltado 12 de 12
 * puede no haber viajado. Cuando eso pasa la tarjeta lo dice y explica como
 * acotar la consulta; cuando llegan menos de 50 la lista es exhaustiva y
 * tambien lo dice. El arreglo de fondo es un `orderBy` en el endpoint, pedido en
 * INTEGRACION.md.
 *
 * El corte entre "cronico" y "ocasional" es una regla de negocio y sale de
 * rules.ts (`chronicMissThresholdPct` y `chronicMissMinPatrols`). Mientras esas
 * reglas no existan en el servidor, la tarjeta sigue sirviendo —ordena por
 * porcentaje— pero no etiqueta nada y lo dice. No hay un numero de negocio
 * escrito en este archivo.
 */

import { DescargarCsv } from './stats-charts-csv';
import {
  formatearEntero,
  formatearPorcentaje,
  plural,
  type PuntosOmitidos,
} from './stats-charts-data';
import { BarrasHorizontales, TablaDatos, type BarraItem } from './stats-charts-svg';
import {
  TOPE_PUNTOS_OMITIDOS,
  clasificarOmisiones,
  omisionesTruncadas,
  resumirOmisiones,
  type PuntoOmision,
  type ReglasOmision,
  type ResultadoSupervisor,
} from './supervisor-datos';
import { EstadoSupervisor, TarjetaSupervisor, VacioSupervisor } from './supervisor-tarjeta';

const COLUMNAS = [
  'Punto',
  'Recinto',
  'Sucursal',
  'Tipo',
  'Rondas esperadas',
  'Veces omitido',
  '% de omisión',
  'Diagnóstico',
];

const TEXTO_NIVEL: Record<PuntoOmision['nivel'], string> = {
  cronico: 'Se omite casi siempre',
  ocasional: 'Se omite a veces',
  'muestra-corta': 'Muy pocas rondas para concluir',
  'sin-clasificar': 'Sin umbral configurado',
};

export function SupervisorOmisiones({
  resultado,
  reglas,
  periodo,
}: {
  resultado: ResultadoSupervisor<PuntosOmitidos>;
  /** `null` = las reglas todavia no estan configuradas en el servidor. */
  reglas: ReglasOmision | null;
  periodo: string;
}) {
  const puntos =
    resultado.estado === 'ok' ? clasificarOmisiones(resultado.datos.checkpoints, reglas) : [];
  const resumen = resumirOmisiones(puntos);
  // El corte del servidor se aplico: puede faltar un punto en esta lista.
  const recortado = omisionesTruncadas(puntos);

  const items: BarraItem[] = puntos.map((punto) => ({
    clave: punto.checkpointId,
    titulo: punto.checkpointName,
    subtitulo: `${punto.siteName} · ${plural(punto.expected, 'ronda', 'rondas')}${
      punto.critico ? ' · acceso crítico' : ''
    }`,
    valor: punto.missedPct,
    etiquetaValor: `${formatearPorcentaje(punto.missedPct)} · ${formatearEntero(
      punto.missed,
    )} de ${formatearEntero(punto.expected)}`,
    alerta: punto.nivel === 'cronico',
    etiquetaAlerta: punto.critico ? 'Crónico en acceso crítico' : 'Crónico',
  }));

  return (
    <TarjetaSupervisor
      id="supervisor-omisiones"
      eyebrow="Dónde se rompe la ronda"
      titulo="Puntos que se omiten siempre"
      explicacion={`Ordenado por cuántas veces se dejó el punto sin marcar respecto de las veces que tocaba, no por el total. Un punto que se salta casi siempre rara vez es descuido del guardia: suele ser la etiqueta despegada, un punto al que no se llega en el tiempo del turno, o una ruta que en la práctica no cabe en el recorrido. Ojo con de dónde sale la lista: el servidor entrega como máximo ${formatearEntero(
        TOPE_PUNTOS_OMITIDOS,
      )} puntos del período y los elige por cantidad TOTAL de omisiones; acá se reordenan esos por porcentaje.`}
      insignia={puntos.length ? plural(puntos.length, 'punto', 'puntos') : undefined}
    >
      <EstadoSupervisor resultado={resultado} />

      {resultado.estado === 'ok' ? (
        puntos.length ? (
          <>
            {/*
              De dónde salió la lista. No es un detalle técnico: si el corte del
              servidor se aplicó, la respuesta a "cuál se omite siempre" puede
              estar incompleta, y una tarjeta que se presenta como completa
              cuando no lo está es peor que no tenerla.
            */}
            {recortado ? (
              <p className="stats-estado aviso" role="status">
                <strong>Puede faltar un punto en esta lista.</strong> El servidor entrega como
                máximo {formatearEntero(TOPE_PUNTOS_OMITIDOS)} puntos por consulta y los elige por
                cantidad total de omisiones, no por porcentaje; llegaron{' '}
                {formatearEntero(puntos.length)}, así que el corte se aplicó. Un punto por el que
                se pasa poco pero se omite siempre (12 de 12) puede haber quedado fuera. Para
                descartarlo, acota el período o filtra por recinto o sucursal arriba: con menos
                puntos en juego el corte deja de aplicarse y esta lista pasa a ser completa.
              </p>
            ) : (
              <p className="section-explanation">
                Llegaron {plural(puntos.length, 'punto', 'puntos')}, menos que el máximo de{' '}
                {formatearEntero(TOPE_PUNTOS_OMITIDOS)} que entrega el servidor: el corte no se
                aplicó, así que están <strong>todos</strong> los puntos que quedaron sin marcar al
                menos una vez en el período y el filtro de arriba, no una selección.
              </p>
            )}

            {reglas === null ? (
              <p className="stats-estado aviso" role="status">
                <strong>Falta configurar cuándo un punto se considera crónico.</strong> La lista
                está ordenada de peor a mejor y las cifras son reales, pero no se marca ninguno
                hasta que la empresa defina desde qué porcentaje de omisión cuenta como crónico y
                con cuántas rondas mínimas. Pídeselo al administrador de la empresa.
              </p>
            ) : null}

            <div className="stat-grid stats-cifras">
              <article className={`stat-card stats-cifra${resumen.cronicos ? ' alerta' : ''}`}>
                <span>Puntos crónicos</span>
                <strong>{reglas === null ? '—' : formatearEntero(resumen.cronicos)}</strong>
                <small>
                  {reglas === null
                    ? 'Sin umbral configurado'
                    : `Se omiten en ${formatearPorcentaje(reglas.umbralPct)} o más de sus rondas`}
                </small>
              </article>
              <article className="stat-card stats-cifra">
                <span>Omisiones del período</span>
                <strong>{formatearEntero(resumen.omisiones)}</strong>
                <small>
                  En {plural(resumen.puntos, 'punto distinto', 'puntos distintos')} de{' '}
                  {plural(resumen.recintos, 'recinto', 'recintos')}
                </small>
              </article>
              <article
                className={`stat-card stats-cifra${resumen.criticosCronicos ? ' alerta' : ''}`}
              >
                <span>Accesos críticos crónicos</span>
                <strong>
                  {reglas === null ? '—' : formatearEntero(resumen.criticosCronicos)}
                </strong>
                <small>
                  {resumen.criticosCronicos
                    ? 'Puertas y porterías que casi nunca se revisan'
                    : 'Ninguna puerta ni portería en esta situación'}
                </small>
              </article>
            </div>

            <BarrasHorizontales
              items={items}
              escala={100}
              referencia={
                reglas === null
                  ? undefined
                  : {
                      valor: reglas.umbralPct,
                      etiqueta: `Crónico desde ${formatearPorcentaje(reglas.umbralPct)}`,
                    }
              }
              ariaLabel={`Puntos de control por porcentaje de omisión, ${periodo}. ${puntos
                .map(
                  (punto) =>
                    `${punto.checkpointName} en ${punto.siteName}: omitido ${formatearEntero(
                      punto.missed,
                    )} de ${formatearEntero(punto.expected)} rondas, ${formatearPorcentaje(
                      punto.missedPct,
                    )}`,
                )
                .join('. ')}.`}
            />

            {/* El diagnostico va como texto y no solo como color de barra: el
                jefe de operaciones imprime esta pantalla y la lleva a reunion. */}
            <ul className="stats-alertas">
              {puntos
                .filter((punto) => punto.nivel === 'cronico' || punto.nivel === 'muestra-corta')
                .map((punto) => (
                  <li key={punto.checkpointId}>
                    <span
                      className={
                        punto.nivel === 'cronico' ? 'stats-chip alerta' : 'stats-chip'
                      }
                    >
                      {TEXTO_NIVEL[punto.nivel]}
                    </span>{' '}
                    {punto.checkpointName} · {punto.siteName}
                  </li>
                ))}
            </ul>

            <TablaDatos
              titulo={`Puntos omitidos ${periodo}`}
              columnas={COLUMNAS}
              filas={puntos.map((punto) => ({
                clave: punto.checkpointId,
                alerta: punto.nivel === 'cronico',
                celdas: [
                  punto.checkpointName,
                  punto.siteName,
                  punto.branchName,
                  punto.critico ? 'Acceso crítico' : 'Normal',
                  formatearEntero(punto.expected),
                  formatearEntero(punto.missed),
                  formatearPorcentaje(punto.missedPct),
                  TEXTO_NIVEL[punto.nivel],
                ],
              }))}
              acciones={
                <DescargarCsv
                  nombre="puntos-que-se-omiten-siempre"
                  columnas={COLUMNAS}
                  filas={puntos.map((punto) => [
                    punto.checkpointName,
                    punto.siteName,
                    punto.branchName,
                    punto.critico ? 'Acceso critico' : 'Normal',
                    String(punto.expected),
                    String(punto.missed),
                    String(punto.missedPct),
                    TEXTO_NIVEL[punto.nivel],
                  ])}
                />
              }
            />
          </>
        ) : (
          <VacioSupervisor
            titulo="No se omitió ningún punto"
            detalle="En este período todas las rondas cerradas de tus recintos pasaron por todos sus puntos. Es la respuesta buena, no una tarjeta en blanco."
          />
        )
      ) : null}
    </TarjetaSupervisor>
  );
}
