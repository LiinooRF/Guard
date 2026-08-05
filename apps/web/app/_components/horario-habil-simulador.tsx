'use client';

/**
 * Comprobacion del horario habil contra el servidor (#68).
 *
 * El criterio del issue es "una ronda de sabado en la madrugada exige foto en
 * cada punto". Eso hay que poder DEMOSTRARLO, y no vale demostrarlo contra una
 * copia de la regla escrita en el navegador: esta pantalla le pregunta a
 * GET /admin/sites/:id/business-hours/check, que por dentro corre el mismo
 * isWithinBusinessHours() y el mismo isPhotoRequired() que el flujo de escaneo.
 *
 * La fecha y la hora se mandan como texto LOCAL DEL RECINTO. El navegador no
 * convierte husos: la conversion la hace Postgres con sites.timezone.
 */
import { useCallback, useEffect, useState } from 'react';

import {
  evaluarHorarioLocal,
  nombreDia,
  proximoDiaDeSemana,
  type FeriadoRecinto,
  type TramoHorario,
} from './horario-habil-modelo';

const SABADO = 6;
/** Hora de la madrugada que usa el atajo del criterio de aceptacion. */
const MADRUGADA = '03:00';

export interface ComprobacionHorario {
  timezone: string;
  localDate: string;
  localTime: string;
  weekday: number;
  instant: string;
  withinBusinessHours: boolean;
  hasSchedule: boolean;
  weekdaySegments: TramoHorario[];
  holiday: { date: string; name: string | null } | null;
  rules: {
    photoRequiredOutsideHours: boolean;
    photoRequiredOnCritical: boolean;
    businessHoursDefaultOpen: boolean;
  };
  checkpoints: {
    total: number;
    requirePhoto: number;
    /**
     * 'override' = el punto tiene «Foto: nunca» propio, que manda sobre el
     * horario. 'reglas' = hoy no la exige por el horario y las reglas vigentes,
     * sin que nadie le haya configurado nada al punto.
     */
    exempt: Array<{ name: string; motivo: 'override' | 'reglas' }>;
  };
}

export function HorarioHabilSimulador({
  apiUrl,
  siteId,
  tramos,
  feriados,
  sinGuardar,
}: {
  apiUrl: string;
  siteId: string;
  tramos: TramoHorario[];
  feriados: FeriadoRecinto[];
  /** Hay ediciones sin guardar: el servidor todavia responde por lo anterior. */
  sinGuardar: boolean;
}) {
  const [fecha, setFecha] = useState('');
  const [hora, setHora] = useState('');
  const [respuesta, setRespuesta] = useState<ComprobacionHorario | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cargando, setCargando] = useState(false);

  const comprobar = useCallback(
    async (date?: string, time?: string) => {
      setCargando(true);
      setError(null);
      try {
        const parametros = date && time ? `?date=${date}&time=${time}` : '';
        const salida = await fetch(
          `${apiUrl}/admin/sites/${siteId}/business-hours/check${parametros}`,
          { credentials: 'include', cache: 'no-store' },
        );
        if (!salida.ok) {
          setError(await mensajeDeError(salida));
          return null;
        }
        const datos = (await salida.json()) as ComprobacionHorario;
        setRespuesta(datos);
        return datos;
      } catch {
        setError('No pudimos comprobar el horario. Revisa la conexión y reintenta.');
        return null;
      } finally {
        setCargando(false);
      }
    },
    [apiUrl, siteId],
  );

  // Al abrir: el "ahora" del recinto, que ademas fija su fecha local. Sin esto
  // habria que adivinar en el navegador que dia es en el huso del recinto.
  useEffect(() => {
    let vigente = true;
    void comprobar().then((datos) => {
      if (!vigente || !datos) return;
      setFecha(datos.localDate);
      setHora(datos.localTime);
    });
    return () => {
      vigente = false;
    };
  }, [comprobar]);

  /*
   * El veredicto del servidor caduca en cuanto se edita el horario: responde por
   * lo que estaba guardado cuando se pidio. Si se quedara pintado, al guardar
   * desaparece el aviso de "cambios sin guardar" y el admin leeria un veredicto
   * viejo como si fuera el de su cambio recien guardado — justo al reves de lo
   * que pasa. Se borra y hay que volver a preguntar.
   */
  useEffect(() => {
    setRespuesta(null);
  }, [tramos, feriados]);

  const local =
    fecha && hora ? evaluarHorarioLocal({ tramos, feriados, fecha, hora }) : null;

  function irAlSabadoDeMadrugada() {
    if (!fecha) return;
    // Se suman dias sobre la fecha local en texto, sin pasar por un instante.
    const sabado = proximoDiaDeSemana(fecha, SABADO);
    setFecha(sabado);
    setHora(MADRUGADA);
    // Se consulta con los valores recien calculados, no con el estado: setFecha
    // no se aplica hasta el proximo render y el boton tiene que responder solo.
    void comprobar(sabado, MADRUGADA);
  }

  return (
    <section className="management-card management-wide">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Comprobación</span>
          <h3>¿Qué pasa a esta hora?</h3>
        </div>
        {respuesta ? <span className="status-pill">{respuesta.timezone}</span> : null}
      </div>

      <p className="section-explanation">
        Escribe una fecha y una hora <strong>del recinto</strong> y el servidor responde con lo
        mismo que decidiría durante una ronda. La conversión de huso y el cálculo los hace el
        servidor: acá no se copia la regla.
      </p>

      <div className="holiday-add">
        <input
          type="date"
          aria-label="Fecha a comprobar"
          value={fecha}
          onChange={(evento) => setFecha(evento.target.value)}
        />
        <input
          type="time"
          aria-label="Hora a comprobar"
          value={hora}
          onChange={(evento) => setHora(evento.target.value)}
        />
        <button
          className="primary-button"
          type="button"
          disabled={cargando || !fecha || !hora}
          onClick={() => void comprobar(fecha, hora)}
        >
          {cargando ? 'Comprobando…' : 'Comprobar en el servidor'}
        </button>
      </div>

      <div className="row-actions">
        <button
          className="secondary-button"
          type="button"
          disabled={cargando || !fecha}
          onClick={irAlSabadoDeMadrugada}
        >
          Probar sábado a las {MADRUGADA}
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={cargando}
          onClick={() =>
            void comprobar().then((datos) => {
              if (!datos) return;
              setFecha(datos.localDate);
              setHora(datos.localTime);
            })
          }
        >
          Ahora en el recinto
        </button>
      </div>

      {sinGuardar ? (
        <p className="form-note">
          Tienes cambios sin guardar. La comprobación responde por el horario ya guardado: guarda
          primero para verlos aplicados.
        </p>
      ) : null}

      {local ? (
        <div className="reglas-previa">
          <strong>Vista previa de lo que estás editando</strong>
          <ul>
            <li className="reglas-cambio ajustado">
              {local.veredicto === 'habil'
                ? 'Dentro de horario hábil'
                : local.veredicto === 'no-habil'
                  ? 'Fuera de horario hábil'
                  : 'No se puede decidir con lo cargado'}
              : {local.motivo}
            </li>
          </ul>
        </div>
      ) : null}

      {error ? (
        <div className="reglas-aviso error" role="alert">
          <strong>{error}</strong>
        </div>
      ) : null}

      {respuesta ? <Veredicto respuesta={respuesta} /> : null}
    </section>
  );
}

/** Lo que respondio el servidor, en lenguaje del cliente. */
function Veredicto({ respuesta }: { respuesta: ComprobacionHorario }) {
  const { checkpoints } = respuesta;
  const todos = checkpoints.total > 0 && checkpoints.requirePhoto === checkpoints.total;
  // Dos motivos distintos y no se pueden mezclar en una sola frase: el override
  // es configuracion del punto (no depende de la hora); el otro es consecuencia
  // del horario de este instante.
  const porOverride = checkpoints.exempt.filter((punto) => punto.motivo === 'override');
  const porReglas = checkpoints.exempt.filter((punto) => punto.motivo === 'reglas');

  return (
    // Verde = regimen normal; ambar = regimen estricto. No es un error: fuera
    // de horario el sistema esta funcionando como debe.
    <div className={respuesta.withinBusinessHours ? 'csv-result' : 'reglas-previa'} role="status">
      <strong>
        {nombreDia(respuesta.weekday)} {respuesta.localDate} a las {respuesta.localTime} (
        {respuesta.timezone}):{' '}
        {respuesta.withinBusinessHours ? 'dentro de horario hábil' : 'fuera de horario hábil'}
      </strong>
      <ul>
        {respuesta.holiday ? (
          <li>
            Es feriado del recinto
            {respuesta.holiday.name ? ` (${respuesta.holiday.name})` : ''}: día no hábil completo.
          </li>
        ) : null}
        {!respuesta.hasSchedule ? (
          <li>
            Este recinto no tiene horario ni feriados cargados, así que el veredicto lo decidió la
            regla «Recinto sin horario cargado cuenta como abierto», que hoy está en{' '}
            {respuesta.rules.businessHoursDefaultOpen ? 'sí' : 'no'}. Carga el horario y vuelve a
            comprobar.
          </li>
        ) : null}
        {respuesta.weekdaySegments.length ? (
          <li>
            Tramos que miró el servidor:{' '}
            {respuesta.weekdaySegments
              .map(
                (tramo) =>
                  `${nombreDia(tramo.weekday).toLocaleLowerCase('es')} ${tramo.opensAt}–${tramo.closesAt}`,
              )
              .join(' · ')}
            .
          </li>
        ) : null}
        <li>
          {checkpoints.total === 0
            ? 'Este recinto no tiene puntos activos, así que no hay evidencia que exigir.'
            : todos
              ? `Exigen foto los ${checkpoints.total} puntos activos.`
              : `Exigen foto ${checkpoints.requirePhoto} de ${checkpoints.total} puntos activos.`}
        </li>
        {porOverride.length ? (
          <li>
            No la exigen por configuración del punto:{' '}
            {porOverride.map((punto) => punto.name).join(', ')}. Tienen «Foto: nunca» propio, que
            manda por sobre el horario a cualquier hora.
          </li>
        ) : null}
        {porReglas.length ? (
          <li>
            No la exigen en este instante: {porReglas.map((punto) => punto.name).join(', ')}. No es
            configuración de esos puntos: es el horario y las reglas de arriba, así que en otro
            momento sí pueden exigirla.
          </li>
        ) : null}
        {!respuesta.withinBusinessHours && !respuesta.rules.photoRequiredOutsideHours ? (
          <li>
            Está fuera de horario, pero la regla «Foto obligatoria fuera de horario» está apagada:
            fuera de horario no se exige foto en todos los puntos, sólo en los que la exigen por
            criticidad o por su propia configuración.
          </li>
        ) : null}
      </ul>
    </div>
  );
}

async function mensajeDeError(respuesta: Response): Promise<string> {
  try {
    const datos = (await respuesta.json()) as { message?: string | string[] };
    if (Array.isArray(datos.message)) return datos.message.join('. ');
    if (datos.message) return datos.message;
  } catch {
    // Sin cuerpo util: cae al texto generico de abajo.
  }
  if (respuesta.status === 403) return 'Tu cuenta no puede consultar la configuración de este recinto.';
  if (respuesta.status === 404) return 'Ese recinto ya no está disponible.';
  return 'No fue posible comprobar el horario.';
}
