'use client';

/**
 * Barra de filtros de la vista de envios (#221).
 *
 * Es lo UNICO de este panel que viaja al navegador, igual que en la auditoria
 * (`auditoria-filtros.tsx`) y en los informes (`stats-charts-filters.tsx`). No
 * trae datos: cambia la URL y deja que el componente de servidor vuelva a pedir
 * todo con la cookie. Asi el estado del panel se puede pegar en un ticket y el
 * boton «atras» del navegador funciona.
 *
 * Cuatro decisiones que no son de estilo:
 *
 * · EN LA URL NO VIAJA NINGUN CORREO. Solo ids de recinto y de ronda, fechas y
 *   claves de plantilla. El destinatario es dato personal y un enlace de esta
 *   pantalla se pega en un ticket o en un chat.
 * · Este panel solo escribe y borra SUS claves (`env_*`). La pagina la comparten
 *   varios bloques que leen los mismos `searchParams` —los informes (#87) usan
 *   `desde`, `hasta` y `recinto`, la auditoria (#104) usa `aud_*`—, asi que
 *   armar un `URLSearchParams` vacio en cada «Aplicar» les borraria el filtro.
 * · LAS FECHAS EXIGEN RECINTO, y se avisa ANTES de consultar.
 *   `RegistroEnviosService.listar()` responde 400 si llegan fechas sin `siteId`
 *   porque el periodo se interpreta en la zona horaria del recinto. Mandarlas
 *   igual pintaria un error de sistema donde en verdad falta elegir un dato.
 * · Elegir una ronda APAGA el resto del formulario. Se contesta con otro
 *   endpoint (`GET /notif/rondas/:id/envios`), que devuelve todos los correos de
 *   esa ronda y no admite filtros: dejar los selectores vivos mostraria un
 *   filtro que no se esta aplicando.
 */

import { useState, useTransition, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

import {
  CATALOGO_ESTADOS,
  CLAVE_URL,
  CLAVES_URL_ENVIOS,
  ESTADOS_ENVIO,
  FILAS_DISPONIBLES,
  FILAS_POR_DEFECTO,
  etiquetaDeRonda,
  type FichaPlantilla,
  type RecintoConocido,
  type RondaConocida,
} from './envios-datos';
import { formatearEntero } from './stats-charts-data';

export interface ValoresFiltroEnvios {
  /** UUID del recinto, o cadena vacia para «todos». */
  recinto: string;
  estado: string;
  plantilla: string;
  desde: string;
  hasta: string;
  /** UUID de la ronda, o cadena vacia. Manda sobre todo lo demas. */
  ronda: string;
  filas: number;
}

export function EnviosFiltros({
  valores,
  recintos,
  plantillas,
  rondas,
  hoy,
  otrosParametros,
}: {
  valores: ValoresFiltroEnvios;
  recintos: readonly RecintoConocido[];
  plantillas: readonly FichaPlantilla[];
  rondas: readonly RondaConocida[];
  /** Hoy en la zona del recinto, calculado en el servidor para no romper la hidratacion. */
  hoy: string;
  /**
   * La query de la pagina SIN las claves de este panel, ya serializada. Llega
   * desde el servidor y se vuelve a mandar entera en cada navegacion.
   */
  otrosParametros?: string;
}) {
  const router = useRouter();
  const [pendiente, iniciarTransicion] = useTransition();
  const [borrador, setBorrador] = useState<ValoresFiltroEnvios>(valores);
  const [error, setError] = useState<string | null>(null);

  const porRonda = borrador.ronda !== '';
  const sinRecinto = borrador.recinto === '';

  /** Lo de los demas bloques, intacto. Este panel nunca escribe estas claves. */
  function ajenos(): URLSearchParams {
    const conservados = new URLSearchParams(otrosParametros ?? '');
    for (const clave of CLAVES_URL_ENVIOS) conservados.delete(clave);
    return conservados;
  }

  /** `?a=b#envios`, y `?#envios` cuando no queda nada: nunca sin `?`. */
  function destino(parametros: URLSearchParams): string {
    return `?${parametros.toString()}#envios`;
  }

  function actualizar(cambio: Partial<ValoresFiltroEnvios>) {
    setError(null);
    setBorrador((actual) => ({ ...actual, ...cambio }));
  }

  function enviar(evento: FormEvent<HTMLFormElement>) {
    evento.preventDefault();
    const parametros = ajenos();

    if (porRonda) {
      parametros.set(CLAVE_URL.ronda, borrador.ronda);
      setError(null);
      iniciarTransicion(() => router.push(destino(parametros), { scroll: false }));
      return;
    }

    if ((borrador.desde || borrador.hasta) && sinRecinto) {
      setError(
        'Para filtrar por fechas elige primero el recinto: el período se lee en su zona horaria, y en Santiago y en Isla de Pascua el día no empieza a la misma hora.',
      );
      return;
    }
    if (borrador.desde && borrador.hasta && borrador.desde > borrador.hasta) {
      setError('La fecha de inicio quedó después de la de término.');
      return;
    }
    if (borrador.hasta && borrador.hasta > hoy) {
      setError('No hay correos de días que todavía no ocurren. El período termina hoy como máximo.');
      return;
    }

    if (borrador.recinto) parametros.set(CLAVE_URL.recinto, borrador.recinto);
    if (borrador.estado) parametros.set(CLAVE_URL.estado, borrador.estado);
    if (borrador.plantilla) parametros.set(CLAVE_URL.plantilla, borrador.plantilla);
    if (borrador.desde) parametros.set(CLAVE_URL.desde, borrador.desde);
    if (borrador.hasta) parametros.set(CLAVE_URL.hasta, borrador.hasta);
    if (borrador.filas !== FILAS_POR_DEFECTO) {
      parametros.set(CLAVE_URL.filas, String(borrador.filas));
    }

    setError(null);
    iniciarTransicion(() => router.push(destino(parametros), { scroll: false }));
  }

  function restablecer() {
    setBorrador({
      recinto: '',
      estado: '',
      plantilla: '',
      desde: '',
      hasta: '',
      ronda: '',
      filas: FILAS_POR_DEFECTO,
    });
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
          <span>Ronda</span>
          <select
            value={borrador.ronda}
            onChange={(evento) => actualizar({ ronda: evento.target.value })}
          >
            <option value="">No filtrar por ronda</option>
            {rondas.map((ronda) => (
              <option key={ronda.id} value={ronda.id}>
                {etiquetaDeRonda(ronda)}
              </option>
            ))}
            {/* La ronda que traia el enlace puede no estar en la lista: el panel
                solo conoce las ultimas rondas visibles. Sin esta opcion el
                navegador mostraria «No filtrar por ronda» y la consulta iria
                filtrada igual. */}
            {borrador.ronda && !rondas.some((ronda) => ronda.id === borrador.ronda) ? (
              <option value={borrador.ronda}>Ronda del enlace ({borrador.ronda.slice(0, 8)})</option>
            ) : null}
          </select>
        </label>

        <label>
          <span>Recinto</span>
          <select
            value={borrador.recinto}
            disabled={porRonda}
            onChange={(evento) => actualizar({ recinto: evento.target.value })}
          >
            <option value="">Todos los recintos</option>
            {recintos.map((recinto) => (
              <option key={recinto.id} value={recinto.id}>
                {recinto.branchName ? `${recinto.branchName} · ` : ''}
                {recinto.name}
                {recinto.isActive ? '' : ' (inactivo)'}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Estado</span>
          <select
            value={borrador.estado}
            disabled={porRonda}
            onChange={(evento) => actualizar({ estado: evento.target.value })}
          >
            <option value="">Todos</option>
            {ESTADOS_ENVIO.map((estado) => (
              <option key={estado} value={estado}>
                {CATALOGO_ESTADOS[estado].etiqueta}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Tipo de correo</span>
          <select
            value={borrador.plantilla}
            disabled={porRonda}
            onChange={(evento) => actualizar({ plantilla: evento.target.value })}
          >
            <option value="">Todos</option>
            {plantillas.map((plantilla) => (
              <option key={plantilla.clave} value={plantilla.clave}>
                {plantilla.etiqueta}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Desde</span>
          <input
            type="date"
            max={hoy}
            value={borrador.desde}
            disabled={porRonda || sinRecinto}
            onChange={(evento) => actualizar({ desde: evento.target.value })}
          />
        </label>

        <label>
          <span>Hasta</span>
          <input
            type="date"
            max={hoy}
            value={borrador.hasta}
            disabled={porRonda || sinRecinto}
            onChange={(evento) => actualizar({ hasta: evento.target.value })}
          />
        </label>

        {porRonda ? null : (
          <label>
            <span>Filas</span>
            <select
              value={String(borrador.filas)}
              onChange={(evento) => actualizar({ filas: Number(evento.target.value) })}
            >
              {FILAS_DISPONIBLES.map((cantidad) => (
                <option key={cantidad} value={cantidad}>
                  {formatearEntero(cantidad)}
                </option>
              ))}
            </select>
          </label>
        )}
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
      </div>

      {error ? (
        <p className="stats-estado error" role="alert">
          {error}
        </p>
      ) : null}

      {!error && porRonda ? (
        <p className="stats-estado aviso" role="status">
          Estás viendo <strong>todos los correos de una ronda</strong>. Mientras haya una ronda
          elegida no se aplican los demás filtros: la consulta trae el correo de esa ronda completo.
        </p>
      ) : null}

      {!error && !porRonda && sinRecinto ? (
        <p className="stats-estado aviso" role="status">
          Para filtrar por fechas elige antes un recinto. El período se lee en la zona horaria del
          recinto (<code>sites.timezone</code>), así que sin recinto no hay reloj con el cual cortar
          los días.
        </p>
      ) : null}
    </form>
  );
}
