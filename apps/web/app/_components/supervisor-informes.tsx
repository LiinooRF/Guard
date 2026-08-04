/**
 * Informes y fotos de los recintos del supervisor (#99).
 *
 * No reimplementa la descarga del PDF ni la galeria de evidencia: eso ya existe
 * y funciona en `informes-panel.tsx` (#88), con el detalle que importa —el PDF
 * se baja con un enlace normal para que el navegador mande la cookie HttpOnly,
 * y los enlaces firmados de las fotos se piden al abrir el anexo porque duran
 * cinco minutos—. Aca se resuelve lo que faltaba: QUE rondas se le pasan a ese
 * panel cuando quien mira es un supervisor.
 *
 * Hoy la pagina lo alimenta con `GET /api/dashboard/tenant`, que devuelve las
 * ultimas rondas visibles de TODOS sus recintos mezcladas y sin poder elegir.
 * Aca se alimenta con `GET /api/supervisor/sites/:siteId/patrols` del recinto
 * elegido, que ademas exige la asignacion en el servidor (`ensureAssignedSite`)
 * y responde 403 si el recinto no es suyo.
 *
 * Ningun nombre de recinto se toma de la URL: el que se muestra sale de la
 * respuesta del servidor o no se muestra ninguno.
 */

import { InformesPanel, type RondaInformable } from './informes-panel';
import { formatearEntero, plural } from './stats-charts-data';
import {
  enlaceRecinto,
  etiquetaEstado,
  type RecintoElegido,
  type ResultadoSupervisor,
  type RondaSupervisor,
} from './supervisor-datos';
import { EstadoSupervisor, TarjetaSupervisor, VacioSupervisor } from './supervisor-tarjeta';

export interface OpcionRecintoSupervisor {
  id: string;
  nombre: string;
  sucursal: string;
}

export function SupervisorInformes({
  resultado,
  recinto,
  recintos,
  rango,
  parametrosUrl,
  apiUrl,
}: {
  resultado: ResultadoSupervisor<RondaSupervisor[]>;
  recinto: RecintoElegido | null;
  /** Recintos que el servidor devolvio para este usuario. Nunca de la URL. */
  recintos: readonly OpcionRecintoSupervisor[];
  rango: { desde: string; hasta: string; sucursal: string };
  /**
   * Los parametros que ya venian en la URL. Los enlaces de esta lista los
   * conservan: sin esto, elegir un recinto borraba `agrupacion` y reseteaba la
   * granularidad de la grafica de evolucion de arriba.
   */
  parametrosUrl?: Readonly<Record<string, string>>;
  apiUrl: string;
}) {
  const rondas = resultado.estado === 'ok' ? resultado.datos : [];

  /*
   * `siteName` se rellena con el nombre confirmado por el servidor. Si el
   * recinto no vino en el listado —puede pasar: esta asignado pero no tuvo
   * rondas en el periodo del filtro— se deja un texto neutro en vez de repetir
   * lo que traia la URL.
   */
  const informables: RondaInformable[] = rondas.map((ronda) => ({
    id: ronda.id,
    siteName: recinto?.nombre ?? 'Recinto asignado',
    routeName: `${ronda.routeName} · ${ronda.guardName}`,
    /*
     * El estado se traduce ACA y no en `informes-panel.tsx`. Su `ESTADO_TEXTO`
     * tiene las claves en ingles (`completed`, `in_progress`…) y la API devuelve
     * las de la base (`completada`, `en_curso`…, ver `patrols_status_check`):
     * ninguna calza nunca y su `?? ronda.status` dejaba el valor crudo en
     * minusculas en todas las filas. Como ese `??` deja pasar cualquier texto,
     * mandarlo ya traducido lo arregla sin tocar un archivo de otro carril.
     * El fix de raiz de ese mapa sigue anotado en INTEGRACION.md §7.
     */
    status: etiquetaEstado(ronda.status),
    scheduledStartAt: ronda.scheduledStartAt,
  }));

  return (
    <TarjetaSupervisor
      id="supervisor-informes"
      eyebrow="Evidencia"
      titulo="Informes y fotos de mis recintos"
      explicacion="El informe en PDF de cada ronda, con el detalle punto por punto y los que quedaron sin marcar, más el anexo fotográfico. Solo aparecen los recintos que tienes asignados: si abres el enlace de un recinto ajeno, el servidor lo rechaza y acá lo verás dicho, no como una lista vacía."
      insignia={rondas.length ? plural(rondas.length, 'ronda', 'rondas') : undefined}
    >
      <EstadoSupervisor resultado={resultado} />

      {recinto === null ? (
        recintos.length ? (
          <>
            <p className="section-explanation">
              Tienes {plural(recintos.length, 'recinto con rondas', 'recintos con rondas')} en
              este período. Elige uno para ver sus informes:
            </p>
            <ul className="stats-alertas">
              {recintos.map((opcion) => (
                <li key={opcion.id}>
                  <a
                    className="secondary-button stats-boton"
                    href={enlaceRecinto(rango, opcion.id, parametrosUrl)}
                  >
                    {opcion.sucursal} · {opcion.nombre}
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <VacioSupervisor
            titulo="No hay recintos con rondas en este período"
            detalle="O todavía no se ejecuta ninguna ronda en tus recintos, o no tienes ninguno asignado. Si crees que debería haber uno, pídele a un administrador de la empresa que te lo asigne."
          />
        )
      ) : null}

      {recinto !== null && resultado.estado === 'ok' ? (
        <>
          {!recinto.confirmado ? (
            <p className="stats-estado aviso" role="status">
              Este recinto no aparece entre los que tuvieron rondas en el período elegido, pero
              sí lo tienes asignado. Lo de abajo es su historial completo, sin filtrar por
              fechas.
            </p>
          ) : null}

          {/* Regla 6 del producto (zona horaria del RECINTO): esta tarjeta es de
              UN recinto, pero las horas las formatea `informes-panel.tsx` con
              `toLocaleString('es-CL')` sin `timeZone`, o sea la del navegador.
              Mientras la API no devuelva `sites.timezone` en este listado, se
              dice; una hora que no es la del recinto y no se declara es una
              lectura equivocada de a que hora paso algo. */}
          {rondas.length ? (
            <p className="section-explanation">
              Las horas de abajo van en la zona horaria de <strong>este dispositivo</strong>, no
              necesariamente en la del recinto. Si estás en otra zona que el recinto, no coinciden.
            </p>
          ) : null}

          <InformesPanel rondas={informables} apiUrl={apiUrl} />

          {rondas.length ? (
            <p className="section-explanation">
              <a
                className="secondary-button stats-boton"
                href={`${apiUrl}/reports/sites/${recinto.id}?from=${rango.desde}&to=${rango.hasta}`}
                target="_blank"
                rel="noreferrer"
              >
                Descargar el resumen del recinto en PDF ({formatearEntero(rondas.length)} rondas
                listadas)
              </a>
            </p>
          ) : null}
        </>
      ) : null}
    </TarjetaSupervisor>
  );
}
