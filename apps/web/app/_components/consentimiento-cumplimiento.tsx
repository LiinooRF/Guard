'use client';

/**
 * Cumplimiento del rastreo — panel del ADMIN (#78).
 *
 * Dos preguntas que hay que poder responder delante de un cliente, un trabajador
 * o un fiscalizador, y que esta pantalla contesta con datos y no con un
 * documento:
 *
 *   1. ¿Quien acepto el aviso, cuando, y quien falta?
 *   2. ¿Hay alguna posicion registrada fuera del turno?
 *
 * La segunda se recorre contra las posiciones REALMENTE guardadas, no contra lo
 * que promete la aplicacion del telefono. Un informe limpio es un cero y una
 * lista vacia; cuando no lo es, aparece el recinto y el DIA DEL RECINTO (cada
 * uno con su zona horaria, que el servidor resuelve).
 */
import { useCallback, useEffect, useState } from 'react';

import { mensajeDeError } from './consentimiento-aviso';

export interface RegistroConsentimiento {
  currentVersion: string | null;
  publishedAt: string | null;
  people: Array<{
    userId: string;
    name: string;
    role: string;
    isActive: boolean;
    status: 'vigente' | 'desactualizado' | 'revocado' | 'nunca_aceptado';
    grantedAt: string | null;
    revokedAt: string | null;
    acceptedVersion: string | null;
    deviceInfo: string | null;
  }>;
  summary: {
    total: number;
    current: number;
    outdated: number;
    revoked: number;
    never: number;
  };
}

interface InformeFueraDeTurno {
  from: string;
  to: string;
  toleranceMin: number;
  summary: {
    points: number;
    patrols: number;
    guards: number;
    beforeStart: number;
    afterClose: number;
    outsideShift: number;
    withoutConsent: number;
  };
  compliant: boolean;
  findings: Array<{
    siteId: string;
    siteName: string;
    timezone: string;
    localDate: string;
    points: number;
    beforeStart: number;
    afterClose: number;
    withoutConsent: number;
  }>;
  truncated: boolean;
}

export function ConsentimientoCumplimiento({
  registro,
  apiUrl,
}: {
  registro: RegistroConsentimiento;
  apiUrl: string;
}) {
  const [desde, setDesde] = useState(() => primerDiaDelMes());
  const [hasta, setHasta] = useState(() => hoy());
  const [informe, setInforme] = useState<InformeFueraDeTurno | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const consultar = useCallback(
    async (from: string, to: string) => {
      setCargando(true);
      setError(null);
      try {
        const respuesta = await fetch(
          `${apiUrl}/consent/off-shift-audit?from=${from}&to=${to}`,
          { credentials: 'include' },
        );
        if (!respuesta.ok) {
          setInforme(null);
          setError(await mensajeDeError(respuesta));
          return;
        }
        setInforme((await respuesta.json()) as InformeFueraDeTurno);
      } catch {
        setInforme(null);
        setError('No pudimos consultar el período. Revisa la conexión y reintenta.');
      } finally {
        setCargando(false);
      }
    },
    [apiUrl],
  );

  // Primera carga con el mes en curso. Los cambios de fecha se piden a mano:
  // teclear una fecha dispararia una consulta por cada digito.
  useEffect(() => {
    void consultar(primerDiaDelMes(), hoy());
  }, [consultar]);

  const pendientes = registro.summary.outdated + registro.summary.never + registro.summary.revoked;

  return (
    <>
      <section className="management-card management-wide" id="registro-consentimiento">
        <div className="card-heading">
          <div>
            <span className="eyebrow">Cumplimiento legal</span>
            <h2>Registro de consentimiento</h2>
          </div>
          <span className="status-pill">
            {registro.summary.current} de {registro.summary.total} al día
          </span>
        </div>
        <p className="section-explanation">
          Quiénes aceptaron el aviso de geolocalización y desde cuándo. Aparece toda la gente que
          puede ser rastreada, aunque no haya aceptado: quien falta es justamente lo que hay que ver.
        </p>

        {registro.currentVersion ? (
          <p className="form-note">
            Versión vigente: {registro.currentVersion}
            {registro.publishedAt ? ` · publicada el ${formatearInstante(registro.publishedAt)}` : ''}
          </p>
        ) : (
          <p className="management-message" role="status">
            No hay un aviso publicado, así que ninguna aceptación está al día. Publica el aviso en la
            sección de arriba.
          </p>
        )}

        {pendientes > 0 ? (
          <p className="management-message" role="status">
            {pendientes === 1
              ? '1 persona no tiene consentimiento vigente: su recorrido no se está registrando.'
              : `${pendientes} personas no tienen consentimiento vigente: su recorrido no se está registrando.`}
          </p>
        ) : null}

        <div className="management-list">
          {registro.people.map((persona) => (
            <article className="management-row" key={persona.userId}>
              <div>
                <strong>{persona.name}</strong>
                <small>
                  {persona.role}
                  {persona.isActive ? '' : ' · cuenta desactivada'}
                </small>
                <small>{detalleDeFecha(persona)}</small>
              </div>
              <span className={`state-chip ${persona.status === 'vigente' ? 'active' : ''}`}>
                {ETIQUETA_ESTADO[persona.status]}
              </span>
            </article>
          ))}
          {!registro.people.length ? (
            <div className="dashboard-empty">
              <strong>Todavía no hay personal en terreno</strong>
              <span>Cuando crees guardias o supervisores aparecerán acá con su consentimiento.</span>
            </div>
          ) : null}
        </div>
      </section>

      <section className="management-card management-wide" id="rastreo-fuera-de-turno">
        <div className="card-heading">
          <div>
            <span className="eyebrow">Cumplimiento legal</span>
            <h2>Ubicación fuera de turno</h2>
          </div>
          {informe ? (
            <span className={`state-chip ${informe.compliant ? 'active' : ''}`}>
              {informe.compliant ? 'Sin hallazgos' : 'Con hallazgos'}
            </span>
          ) : null}
        </div>
        <p className="section-explanation">
          Revisa una a una las posiciones guardadas en el período y las contrasta con la ventana de
          su ronda. Es la evidencia de que no se registra ubicación fuera del turno.
        </p>

        <div className="tenant-filters">
          <label>
            <span>Desde</span>
            <input
              type="date"
              value={desde}
              onChange={(evento) => setDesde(evento.target.value)}
            />
          </label>
          <label>
            <span>Hasta</span>
            <input type="date" value={hasta} onChange={(evento) => setHasta(evento.target.value)} />
          </label>
          <button
            type="button"
            className="secondary-button"
            disabled={cargando || !desde || !hasta}
            onClick={() => void consultar(desde, hasta)}
          >
            {cargando ? 'Revisando…' : 'Revisar período'}
          </button>
        </div>

        {error ? (
          <p className="management-message" role="status">
            {error}
          </p>
        ) : null}

        {informe ? (
          <>
            <section className="stat-grid">
              <Dato
                etiqueta="Posiciones revisadas"
                valor={informe.summary.points}
                detalle={`${informe.summary.patrols} rondas · ${informe.summary.guards} personas`}
              />
              <Dato
                etiqueta="Fuera del turno"
                valor={informe.summary.outsideShift}
                detalle={`${informe.summary.beforeStart} antes de iniciar · ${informe.summary.afterClose} tras cerrar`}
              />
              <Dato
                etiqueta="Sin consentimiento"
                valor={informe.summary.withoutConsent}
                detalle="Registradas sin aceptación vigente en ese momento"
              />
            </section>

            <p className="section-explanation">{frase(informe)}</p>

            {informe.findings.length ? (
              <div className="management-list">
                {informe.findings.map((hallazgo) => (
                  <article
                    className="management-row"
                    key={`${hallazgo.siteId}-${hallazgo.localDate}`}
                  >
                    <div>
                      <strong>
                        {hallazgo.siteName} · {hallazgo.localDate}
                      </strong>
                      <small>
                        {hallazgo.beforeStart} antes de iniciar · {hallazgo.afterClose} tras cerrar ·{' '}
                        {hallazgo.withoutConsent} sin consentimiento
                      </small>
                      <small>
                        Fecha del recinto ({hallazgo.timezone}), no la del servidor · {hallazgo.points}{' '}
                        posiciones ese día
                      </small>
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="dashboard-empty">
                <strong>Sin registros fuera de turno en el período</strong>
                <span>
                  Ninguna posición quedó guardada antes de que la ronda empezara ni después de que
                  cerrara.
                </span>
              </div>
            )}

            {informe.truncated ? (
              <p className="form-note">
                Se muestran los primeros 100 días con hallazgos. Acota el período para verlos todos.
              </p>
            ) : null}

            <p className="form-note">
              Se descuenta un desfase de reloj de hasta {informe.toleranceMin} minutos: un teléfono
              con la hora corrida no es rastreo fuera de turno. Ese margen se configura en las reglas
              de la empresa.
            </p>
          </>
        ) : null}
      </section>
    </>
  );
}

function Dato({
  etiqueta,
  valor,
  detalle,
}: {
  etiqueta: string;
  valor: number;
  detalle: string;
}) {
  return (
    <article className="stat-card">
      <span>{etiqueta}</span>
      <strong>{new Intl.NumberFormat('es-CL').format(valor)}</strong>
      <small>{detalle}</small>
    </article>
  );
}

const ETIQUETA_ESTADO: Record<RegistroConsentimiento['people'][number]['status'], string> = {
  vigente: 'Al día',
  desactualizado: 'Aviso antiguo',
  revocado: 'Retirado',
  nunca_aceptado: 'Sin aceptar',
};

function detalleDeFecha(persona: RegistroConsentimiento['people'][number]) {
  if (persona.status === 'nunca_aceptado') return 'Nunca aceptó el aviso';
  if (persona.revokedAt) return `Retirado el ${formatearInstante(persona.revokedAt)}`;
  const version = persona.acceptedVersion ? ` (versión ${persona.acceptedVersion})` : '';
  return persona.grantedAt
    ? `Aceptado el ${formatearInstante(persona.grantedAt)}${version}`
    : 'Sin fecha registrada';
}

function frase(informe: InformeFueraDeTurno) {
  const periodo = `entre el ${formatearFecha(informe.from)} y el ${formatearFecha(informe.to)}`;
  if (informe.summary.points === 0) {
    return `No hay posiciones registradas ${periodo}.`;
  }
  if (informe.compliant) {
    return `Se revisaron ${informe.summary.points} posiciones ${periodo} y ninguna quedó fuera del turno ni sin consentimiento vigente.`;
  }
  return `De ${informe.summary.points} posiciones revisadas ${periodo}, ${informe.summary.outsideShift} quedaron fuera del turno y ${informe.summary.withoutConsent} sin consentimiento vigente. Revisa el detalle antes de responderle al cliente.`;
}

/**
 * Fecha local en AAAA-MM-DD. toISOString() NO sirve: convierte a UTC y en Chile
 * devuelve el dia siguiente durante buena parte de la tarde.
 */
function comoFecha(valor: Date): string {
  const mes = `${valor.getMonth() + 1}`.padStart(2, '0');
  const dia = `${valor.getDate()}`.padStart(2, '0');
  return `${valor.getFullYear()}-${mes}-${dia}`;
}

function hoy(): string {
  return comoFecha(new Date());
}

/** El mes en curso: un periodo del calendario, no una cantidad de dias inventada. */
function primerDiaDelMes(): string {
  const ahora = new Date();
  return comoFecha(new Date(ahora.getFullYear(), ahora.getMonth(), 1));
}

/** Para instantes completos (aceptaciones, publicaciones): fecha y hora local. */
function formatearInstante(valor: string) {
  return new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(valor),
  );
}

function formatearFecha(valor: string) {
  // Las fechas del informe vienen como AAAA-MM-DD (sin hora): se interpretan
  // como fecha local para que no se corran un dia al formatear.
  const partes = valor.slice(0, 10).split('-');
  const anio = Number(partes[0]);
  const mes = Number(partes[1]);
  const dia = Number(partes[2]);
  if (!anio || !mes || !dia) return valor;
  return new Intl.DateTimeFormat('es-CL', { dateStyle: 'medium' }).format(
    new Date(anio, mes - 1, dia),
  );
}
