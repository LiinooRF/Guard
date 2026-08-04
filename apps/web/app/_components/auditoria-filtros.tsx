'use client';

/**
 * Barra de filtros de la auditoria (#104).
 *
 * Es lo UNICO de este panel que viaja al navegador, igual que en los informes
 * (`stats-charts-filters.tsx`). No trae datos: cambia la URL y deja que el
 * componente de servidor vuelva a pedir todo. Asi el estado del panel se puede
 * guardar en favoritos o mandar por chat —"mira lo que se cambio esa semana"—
 * y el boton "atras" del navegador funciona.
 *
 * Tres decisiones que no son de estilo:
 *
 * · En la URL viajan el UUID del usuario y el codigo de la accion, NUNCA el
 *   nombre ni el correo de nadie. Un enlace de auditoria se pega en un correo
 *   o en un ticket y no puede llevar datos de personas encima.
 * · Este panel solo escribe y borra SUS claves (`aud_*`). La pagina la
 *   comparten varios bloques que leen los mismos `searchParams` —los informes
 *   (#87) usan `desde`, `hasta`, `recinto`, `sucursal` y `agrupacion`— y armar
 *   un `URLSearchParams` vacio en cada "Aplicar" les borraria el filtro. Por
 *   eso se parte de lo que ya venia (`otrosParametros`) y "Limpiar" solo saca
 *   lo propio.
 * · Aplicar un filtro BORRA el cursor de paginado. Si no, se cambia el periodo
 *   y la pagina sigue anclada en un instante viejo, que es la forma mas facil
 *   de mostrar un listado que no corresponde al encabezado.
 * · Elegir una accion que el servidor todavia no registra avisa ANTES de
 *   consultarla. Ver cero filas y creer que no paso nada es exactamente el
 *   error que una auditoria tiene que evitar.
 */

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import {
  CLAVE_URL,
  CLAVES_URL_AUDITORIA,
  agruparAcciones,
  describirAccion,
  diasEntreCalendario,
  esDiaCalendario,
  sumarDiasCalendario,
  type FichaAccion,
  type OpcionActor,
} from './auditoria-datos';
import { RANGOS_RAPIDOS, formatearEntero } from './stats-charts-data';

export interface ValoresFiltroAuditoria {
  desde: string;
  hasta: string;
  /** UUID del usuario, o cadena vacia para "cualquiera". */
  usuario: string;
  /** Codigo de accion, o cadena vacia para "todas". */
  accion: string;
}

export function AuditoriaFiltros({
  valores,
  actores,
  acciones,
  hoy,
  diasMaximos,
  diasPorDefecto,
  otrosParametros,
}: {
  valores: ValoresFiltroAuditoria;
  actores: readonly OpcionActor[];
  acciones: readonly FichaAccion[];
  /** Hoy en la zona del recinto, calculado en el servidor para no romper la hidratacion. */
  hoy: string;
  diasMaximos: number;
  diasPorDefecto: number;
  /**
   * La query de la pagina SIN las claves de este panel, ya serializada (por
   * ejemplo `desde=2026-01-01&hasta=2026-08-03&agrupacion=mes`, de los
   * informes). Llega desde el servidor y se vuelve a mandar entera en cada
   * navegacion. Vacia si no hay ninguna.
   */
  otrosParametros?: string;
}) {
  const router = useRouter();
  const [pendiente, iniciarTransicion] = useTransition();
  const [borrador, setBorrador] = useState<ValoresFiltroAuditoria>(valores);
  const [error, setError] = useState<string | null>(null);

  /** Lo de los demas bloques, intacto. Este panel nunca escribe estas claves. */
  function ajenos(): URLSearchParams {
    const conservados = new URLSearchParams(otrosParametros ?? '');
    // Cinturon y tirantes: si alguna vez llegara una clave propia por aca, se
    // saca. Las `aud_*` las manda el estado del formulario, no el arrastre.
    for (const clave of CLAVES_URL_AUDITORIA) conservados.delete(clave);
    return conservados;
  }

  /** `?a=b#auditoria`, y `?#auditoria` cuando no queda nada: nunca sin `?`. */
  function destino(parametros: URLSearchParams): string {
    return `?${parametros.toString()}#auditoria`;
  }

  const rangoValido =
    esDiaCalendario(borrador.desde) &&
    esDiaCalendario(borrador.hasta) &&
    borrador.desde <= borrador.hasta;
  const dias = rangoValido ? diasEntreCalendario(borrador.desde, borrador.hasta) : 0;
  const rapidos = RANGOS_RAPIDOS.filter((rango) => rango.dias <= diasMaximos);
  const grupos = agruparAcciones(acciones);
  const elegida = borrador.accion ? describirAccion(borrador.accion) : null;

  function actualizar(cambio: Partial<ValoresFiltroAuditoria>) {
    setError(null);
    setBorrador((actual) => ({ ...actual, ...cambio }));
  }

  function aplicarRangoRapido(clave: string) {
    const rango = rapidos.find((candidato) => candidato.clave === clave);
    if (!rango) return;
    actualizar({ hasta: hoy, desde: sumarDiasCalendario(hoy, -(rango.dias - 1)) });
  }

  function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();

    if (!esDiaCalendario(borrador.desde) || !esDiaCalendario(borrador.hasta)) {
      setError('Revisa las fechas: falta el día de inicio o el de término.');
      return;
    }
    if (borrador.desde > borrador.hasta) {
      setError('La fecha de inicio quedó después de la de término.');
      return;
    }
    if (borrador.hasta > hoy) {
      setError('No hay acciones de días que todavía no ocurren. El período termina hoy como máximo.');
      return;
    }
    if (dias > diasMaximos) {
      setError(
        `Pediste ${formatearEntero(dias)} días y el panel revisa hasta ${formatearEntero(
          diasMaximos,
        )} de una vez. Acorta el período o filtra por usuario o por tipo de acción.`,
      );
      return;
    }

    const parametros = ajenos();
    parametros.set(CLAVE_URL.desde, borrador.desde);
    parametros.set(CLAVE_URL.hasta, borrador.hasta);
    if (borrador.usuario) parametros.set(CLAVE_URL.usuario, borrador.usuario);
    if (borrador.accion) parametros.set(CLAVE_URL.accion, borrador.accion);
    // Sin `aud_antes`: un filtro nuevo empieza en la pagina uno.
    setError(null);
    iniciarTransicion(() => router.push(destino(parametros), { scroll: false }));
  }

  function restablecer() {
    const inicial: ValoresFiltroAuditoria = {
      desde: sumarDiasCalendario(hoy, -(diasPorDefecto - 1)),
      hasta: hoy,
      usuario: '',
      accion: '',
    };
    setBorrador(inicial);
    setError(null);
    // «Limpiar» limpia ESTE panel. Vaciar la query entera se llevaria por
    // delante el periodo y el recinto de los informes, que estan en la misma
    // pagina y no son de este bloque.
    iniciarTransicion(() => router.push(destino(ajenos()), { scroll: false }));
  }

  return (
    <form className="stats-filtros" onSubmit={enviar}>
      <div className="stats-filtros-campos">
        <label>
          <span>Período</span>
          <select
            value={rapidos.find((rango) => rango.dias === dias)?.clave ?? 'personalizado'}
            onChange={(evento) => aplicarRangoRapido(evento.target.value)}
          >
            {rapidos.map((rango) => (
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
          <span>Usuario</span>
          <select
            value={borrador.usuario}
            onChange={(evento) => actualizar({ usuario: evento.target.value })}
          >
            <option value="">Cualquiera</option>
            {actores.map((actor) => (
              <option key={actor.id} value={actor.id}>
                {actor.nombre}
                {actor.historico ? ' (cuenta eliminada)' : ''}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Tipo de acción</span>
          <select
            value={borrador.accion}
            onChange={(evento) => actualizar({ accion: evento.target.value })}
          >
            <option value="">Todas</option>
            {grupos.map((grupo) => (
              <optgroup key={grupo.grupo} label={grupo.etiqueta}>
                {grupo.acciones.map((ficha) => (
                  <option key={ficha.codigo} value={ficha.codigo}>
                    {ficha.etiqueta}
                    {ficha.registro === 'ausente' ? ' — sin registro' : ''}
                    {ficha.registro === 'parcial' ? ' — registro parcial' : ''}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      </div>

      <div className="stats-filtros-acciones">
        <button className="primary-button stats-boton" disabled={pendiente}>
          {pendiente ? 'Buscando…' : 'Aplicar filtros'}
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={restablecer}
          disabled={pendiente}
        >
          Limpiar
        </button>
        {rangoValido ? (
          <span className="stats-filtros-conteo">
            {formatearEntero(dias)} {dias === 1 ? 'día seleccionado' : 'días seleccionados'}
          </span>
        ) : null}
      </div>

      {error ? (
        <p className="stats-estado error" role="alert">
          {error}
        </p>
      ) : null}

      {/* Aviso, no error: el filtro es valido, lo que pasa es que el servidor
          todavia no escribe esa accion. Vale la pena decirlo antes de que el
          listado salga vacio y se lea como "no pasó nada". */}
      {!error && elegida && elegida.registro !== 'completo' && elegida.nota ? (
        <p className="stats-estado aviso" role="status">
          <strong>{elegida.etiqueta}:</strong> {elegida.nota} Lo que veas abajo puede quedar
          corto, y no porque no haya ocurrido.
        </p>
      ) : null}
    </form>
  );
}
