'use client';

/**
 * Barra de filtros de los informes (#87).
 *
 * Es el UNICO pedazo de este carril que se manda al navegador, y solo porque
 * elegir un periodo es interaccion de verdad. No trae datos: cambia la URL y
 * deja que el componente de servidor vuelva a pedir todo. Asi las cuatro
 * graficas se dibujan siempre contra el mismo corte —una sola fila de filtros
 * arriba, nunca un filtro por tarjeta— y el estado del panel se puede guardar
 * en favoritos o mandar por chat.
 *
 * Lo importante que hace: IMPEDIR el rango que la API va a rechazar. El
 * servidor devuelve 400 con un texto correcto pero de ingeniero; aca se explica
 * antes, en castellano, y ni siquiera se llega a pedir.
 */

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import {
  DIAS_POR_DEFECTO,
  MOTIVO_TOPE,
  NOMBRE_GRAFICA,
  RANGOS_RAPIDOS,
  TOPE_MAXIMO,
  diasEntre,
  esDia,
  formatearEntero,
  graficasLimitadas,
  sumarDias,
  type Granularidad,
} from './stats-charts-data';

export interface ValoresFiltro {
  desde: string;
  hasta: string;
  /** Id del recinto, o cadena vacia para "todos los que puedo ver". */
  recinto: string;
  /** Nombre de la sucursal, o cadena vacia para todas. */
  sucursal: string;
  agrupacion: Granularidad;
}

export function StatsChartsFilters({
  valores,
  recintos,
  sucursales,
  hoy,
}: {
  valores: ValoresFiltro;
  recintos: Array<{ id: string; nombre: string; sucursal: string }>;
  sucursales: string[];
  hoy: string;
}) {
  const router = useRouter();
  const [pendiente, iniciarTransicion] = useTransition();
  const [borrador, setBorrador] = useState<ValoresFiltro>(valores);
  const [error, setError] = useState<string | null>(null);

  const rangoValido = esDia(borrador.desde) && esDia(borrador.hasta) && borrador.desde <= borrador.hasta;
  const dias = rangoValido ? diasEntre(borrador.desde, borrador.hasta) : 0;
  const limitadas = rangoValido ? graficasLimitadas(dias) : [];

  function actualizar(cambio: Partial<ValoresFiltro>) {
    setError(null);
    setBorrador((actual) => ({ ...actual, ...cambio }));
  }

  function aplicarRangoRapido(clave: string) {
    const rango = RANGOS_RAPIDOS.find((candidato) => candidato.clave === clave);
    if (!rango) return;
    actualizar({ hasta: hoy, desde: sumarDias(hoy, -(rango.dias - 1)) });
  }

  function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();

    if (!esDia(borrador.desde) || !esDia(borrador.hasta)) {
      setError('Revisa las fechas: falta el día de inicio o el de término.');
      return;
    }
    if (borrador.desde > borrador.hasta) {
      setError('La fecha de inicio quedó después de la de término.');
      return;
    }
    if (borrador.hasta > hoy) {
      setError('No hay datos de días que todavía no ocurren. El período termina hoy como máximo.');
      return;
    }
    if (dias > TOPE_MAXIMO) {
      setError(
        `Pediste ${formatearEntero(dias)} días y el panel muestra hasta ${formatearEntero(
          TOPE_MAXIMO,
        )} (dos años). Con más historia que eso la consulta deja la base sin memoria y se cae para todos, así que acorta el período o descarga el informe en PDF.`,
      );
      return;
    }

    const parametros = new URLSearchParams();
    parametros.set('desde', borrador.desde);
    parametros.set('hasta', borrador.hasta);
    if (borrador.recinto) parametros.set('recinto', borrador.recinto);
    if (borrador.sucursal) parametros.set('sucursal', borrador.sucursal);
    parametros.set('agrupacion', borrador.agrupacion);
    setError(null);
    iniciarTransicion(() => router.push(`?${parametros.toString()}#informes`, { scroll: false }));
  }

  function restablecer() {
    const inicial: ValoresFiltro = {
      desde: sumarDias(hoy, -(DIAS_POR_DEFECTO - 1)),
      hasta: hoy,
      recinto: '',
      sucursal: '',
      agrupacion: 'dia',
    };
    setBorrador(inicial);
    setError(null);
    iniciarTransicion(() => router.push('?', { scroll: false }));
  }

  return (
    <form className="stats-filtros" onSubmit={enviar}>
      <div className="stats-filtros-campos">
        <label>
          <span>Período</span>
          <select
            value={RANGOS_RAPIDOS.find((rango) => rango.dias === dias)?.clave ?? 'personalizado'}
            onChange={(evento) => aplicarRangoRapido(evento.target.value)}
          >
            {RANGOS_RAPIDOS.map((rango) => (
              <option key={rango.clave} value={rango.clave}>
                {rango.etiqueta}
              </option>
            ))}
            <option value="personalizado">Personalizado</option>
          </select>
        </label>

        <label>
          <span>Desde</span>
          <input
            type="date"
            max={hoy}
            value={borrador.desde}
            onChange={(evento) => actualizar({ desde: evento.target.value })}
          />
        </label>

        <label>
          <span>Hasta</span>
          <input
            type="date"
            max={hoy}
            value={borrador.hasta}
            onChange={(evento) => actualizar({ hasta: evento.target.value })}
          />
        </label>

        <label>
          <span>Sucursal</span>
          <select
            value={borrador.sucursal}
            onChange={(evento) => actualizar({ sucursal: evento.target.value, recinto: '' })}
          >
            <option value="">Todas</option>
            {sucursales.map((sucursal) => (
              <option key={sucursal} value={sucursal}>
                {sucursal}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Recinto</span>
          <select
            value={borrador.recinto}
            onChange={(evento) => actualizar({ recinto: evento.target.value })}
          >
            <option value="">Todos los que puedo ver</option>
            {recintos
              .filter((recinto) => !borrador.sucursal || recinto.sucursal === borrador.sucursal)
              .map((recinto) => (
                <option key={recinto.id} value={recinto.id}>
                  {recinto.sucursal} · {recinto.nombre}
                </option>
              ))}
          </select>
        </label>

        <label>
          <span>Agrupar por</span>
          <select
            value={borrador.agrupacion}
            onChange={(evento) =>
              actualizar({ agrupacion: evento.target.value as Granularidad })
            }
          >
            <option value="dia">Día</option>
            <option value="semana">Semana</option>
            <option value="mes">Mes</option>
          </select>
        </label>
      </div>

      <div className="stats-filtros-acciones">
        <button className="primary-button stats-boton" disabled={pendiente}>
          {pendiente ? 'Actualizando…' : 'Aplicar período'}
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={restablecer}
          disabled={pendiente}
        >
          Volver a los últimos 30 días
        </button>
        {rangoValido ? (
          <span className="stats-filtros-conteo">{formatearEntero(dias)} días seleccionados</span>
        ) : null}
      </div>

      {error ? (
        <p className="stats-estado error" role="alert">
          {error}
        </p>
      ) : null}

      {/* Aviso, no error: el periodo es valido para casi todo el panel, y solo
          algunas graficas no llegan tan atras. Se dice cuales y por que ANTES
          de aplicarlo, para que nadie se encuentre con una tarjeta en blanco. */}
      {!error && limitadas.length ? (
        <p className="stats-estado aviso" role="status">
          Con {formatearEntero(dias)} días no se pueden mostrar{' '}
          {limitadas.map((clave) => NOMBRE_GRAFICA[clave]).join(' ni ')}.{' '}
          {limitadas.map((clave) => MOTIVO_TOPE[clave]).join(' ')} El resto del panel sí se
          actualiza.
        </p>
      ) : null}
    </form>
  );
}
