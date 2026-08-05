'use client';

/**
 * Horario habil de un recinto: editor + feriados + comprobacion (#68).
 *
 * Es el bloque completo que se monta dentro del detalle de un recinto. Carga y
 * guarda por su cuenta contra /admin/sites/:id/business-hours y /holidays, para
 * que integrarlo sea una sola linea y no repartir estado por el panel.
 *
 * Guardar aplica en el acto: la decision de foto se resuelve en cada escaneo
 * leyendo estas tablas, asi que cambiar el horario cambia el comportamiento en
 * terreno sin desplegar nada.
 */
import { useCallback, useEffect, useState } from 'react';

import { HorarioHabilFeriados } from './horario-habil-feriados';
import { HorarioHabilSemana } from './horario-habil-semana';
import { HorarioHabilSimulador } from './horario-habil-simulador';
import {
  erroresDeSemana,
  type FeriadoRecinto,
  type TramoHorario,
} from './horario-habil-modelo';

interface Aviso {
  tono: 'ok' | 'error';
  texto: string;
}

export function HorarioHabilPanel({
  apiUrl,
  siteId,
  siteName,
  timezone,
}: {
  apiUrl: string;
  siteId: string;
  siteName: string;
  /** sites.timezone del recinto: la zona en que se leen horas y fechas. */
  timezone: string;
}) {
  const [tramos, setTramos] = useState<TramoHorario[]>([]);
  const [feriados, setFeriados] = useState<FeriadoRecinto[]>([]);
  const [guardadoTramos, setGuardadoTramos] = useState<TramoHorario[]>([]);
  const [guardadoFeriados, setGuardadoFeriados] = useState<FeriadoRecinto[]>([]);
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [aviso, setAviso] = useState<Aviso | null>(null);
  const [sinDatos, setSinDatos] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setAviso(null);
    try {
      const [horario, calendario] = await Promise.all([
        fetch(`${apiUrl}/admin/sites/${siteId}/business-hours`, opciones()),
        fetch(`${apiUrl}/admin/sites/${siteId}/holidays`, opciones()),
      ]);
      if (!horario.ok || !calendario.ok) {
        setSinDatos(true);
        setAviso({ tono: 'error', texto: await mensajeDeError(horario.ok ? calendario : horario) });
        return;
      }
      const listaTramos = (await horario.json()) as TramoHorario[];
      const listaFeriados = (await calendario.json()) as FeriadoRecinto[];
      setSinDatos(false);
      setTramos(listaTramos);
      setGuardadoTramos(listaTramos);
      setFeriados(listaFeriados);
      setGuardadoFeriados(listaFeriados);
    } catch {
      setSinDatos(true);
      setAviso({ tono: 'error', texto: 'No pudimos cargar el horario del recinto. Reintenta.' });
    } finally {
      setCargando(false);
    }
  }, [apiUrl, siteId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const errores = erroresDeSemana(tramos);
  const cambiosEnTramos = !mismaLista(tramos, guardadoTramos, claveTramo);
  const cambiosEnFeriados = !mismaLista(feriados, guardadoFeriados, claveFeriado);
  const hayCambios = cambiosEnTramos || cambiosEnFeriados;

  async function guardar() {
    if (errores.size || !hayCambios) return;
    setGuardando(true);
    setAviso(null);
    try {
      // El PUT reemplaza el set completo del recinto: lo que no va, se borra.
      if (cambiosEnTramos) {
        const salida = await enviar(`${apiUrl}/admin/sites/${siteId}/business-hours`, { hours: tramos });
        if (!salida.ok) {
          setAviso({ tono: 'error', texto: await mensajeDeError(salida) });
          return;
        }
        const lista = (await salida.json()) as TramoHorario[];
        setTramos(lista);
        setGuardadoTramos(lista);
      }
      if (cambiosEnFeriados) {
        const salida = await enviar(`${apiUrl}/admin/sites/${siteId}/holidays`, { holidays: feriados });
        if (!salida.ok) {
          setAviso({ tono: 'error', texto: await mensajeDeError(salida) });
          return;
        }
        const lista = (await salida.json()) as FeriadoRecinto[];
        setFeriados(lista);
        setGuardadoFeriados(lista);
      }
      setAviso({
        tono: 'ok',
        texto:
          'Guardado. Rige desde el próximo escaneo, sin desplegar nada. Comprueba abajo cómo queda un sábado de madrugada.',
      });
    } catch {
      setAviso({ tono: 'error', texto: 'No pudimos guardar. Revisa la conexión y reintenta.' });
    } finally {
      setGuardando(false);
    }
  }

  if (cargando) {
    return (
      <section className="management-card management-wide">
        <p className="dashboard-empty">Cargando el horario del recinto…</p>
      </section>
    );
  }

  if (sinDatos) {
    return (
      <section className="management-card management-wide">
        <div className="dashboard-empty">
          <strong>No pudimos mostrar el horario de este recinto</strong>
          <span>{aviso?.texto ?? 'Reintenta en unos segundos.'}</span>
        </div>
        <button className="secondary-button" type="button" onClick={() => void cargar()}>
          Reintentar
        </button>
      </section>
    );
  }

  return (
    <section className="site-detail" id="horario-habil">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Horario</span>
          <h2>Horario hábil de {siteName}</h2>
        </div>
        <span className="status-pill">{timezone}</span>
      </div>

      {aviso ? (
        // `csv-result` para el exito: globals.css esta prohibido y ahi no existe
        // `.reglas-aviso.ok`, asi que un modificador inventado saldria con el
        // azul informativo y el guardado no se distinguiria de un aviso.
        // `csv-result` ya esta definida en verde (globals.css:212).
        <div
          className={aviso.tono === 'ok' ? 'csv-result' : 'reglas-aviso error'}
          role={aviso.tono === 'ok' ? 'status' : 'alert'}
        >
          <strong>{aviso.texto}</strong>
        </div>
      ) : null}

      <div className="management-grid">
        <HorarioHabilSemana
          tramos={tramos}
          zonaHoraria={timezone}
          bloqueado={guardando}
          onCambiar={setTramos}
        />
        <HorarioHabilFeriados
          feriados={feriados}
          zonaHoraria={timezone}
          bloqueado={guardando}
          onCambiar={setFeriados}
        />
      </div>

      <div className="reglas-barra">
        <span className="reglas-barra-texto">
          {errores.size
            ? 'Hay días con la apertura igual al cierre. Corrígelos para poder guardar.'
            : hayCambios
              ? 'Cambios sin guardar. En terreno todavía rige el horario anterior.'
              : 'Sin cambios pendientes.'}
        </span>
        <span className="reglas-barra-acciones">
          <button
            type="button"
            className="secondary-button"
            disabled={!hayCambios || guardando}
            onClick={() => {
              setTramos(guardadoTramos);
              setFeriados(guardadoFeriados);
              setAviso(null);
            }}
          >
            Descartar cambios
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!hayCambios || guardando || errores.size > 0}
            onClick={() => void guardar()}
          >
            {guardando ? 'Guardando…' : 'Guardar horario'}
          </button>
        </span>
      </div>

      <HorarioHabilSimulador
        apiUrl={apiUrl}
        siteId={siteId}
        tramos={tramos}
        feriados={feriados}
        sinGuardar={hayCambios}
      />
    </section>
  );
}

function claveTramo(tramo: TramoHorario): string {
  return `${tramo.weekday}|${tramo.opensAt}|${tramo.closesAt}`;
}

function claveFeriado(feriado: FeriadoRecinto): string {
  return `${feriado.date}|${feriado.name ?? ''}`;
}

/** Compara sin depender del orden: el servidor devuelve ordenado, el editor no. */
function mismaLista<T>(a: readonly T[], b: readonly T[], clave: (item: T) => string): boolean {
  if (a.length !== b.length) return false;
  const izquierda = a.map(clave).sort();
  const derecha = b.map(clave).sort();
  return izquierda.every((valor, indice) => valor === derecha[indice]);
}

function opciones(): RequestInit {
  return { credentials: 'include', cache: 'no-store' };
}

function enviar(url: string, cuerpo: object) {
  return fetch(url, {
    method: 'PUT',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
}

async function mensajeDeError(respuesta: Response): Promise<string> {
  try {
    const datos = (await respuesta.json()) as { message?: string | string[] };
    if (Array.isArray(datos.message)) return datos.message.join('. ');
    if (datos.message) return datos.message;
  } catch {
    // Sin cuerpo util: cae al texto generico de abajo.
  }
  if (respuesta.status === 403) return 'Tu cuenta no puede configurar este recinto.';
  if (respuesta.status === 404) return 'Ese recinto ya no está disponible.';
  return 'No fue posible completar la operación.';
}
