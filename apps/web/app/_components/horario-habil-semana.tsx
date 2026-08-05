'use client';

/**
 * Editor del horario habil semanal de un recinto (#68).
 *
 * La interfaz tiene que reflejar la regla de medianoche del servidor, no
 * contradecirla: un tramo con cierre menor que la apertura cruza el dia, y la
 * madrugada resultante pertenece a la fila del dia ANTERIOR. Por eso debajo de
 * la grilla se muestra la COBERTURA de cada dia con el dia del que sale cada
 * franja — es lo unico que hace entendible que "el sabado de madrugada" se
 * configure en la fila del viernes.
 */
import {
  coberturaDelDia,
  cruzaMedianoche,
  descripcionFranja,
  descripcionTramo,
  DIAS,
  diasSinCobertura,
  erroresDeSemana,
  nombreDia,
  type TramoHorario,
} from './horario-habil-modelo';

/** Semilla del formulario al marcar un dia nuevo, no una regla de negocio. */
const TRAMO_SEMILLA = { opensAt: '09:00', closesAt: '18:00' };

export function HorarioHabilSemana({
  tramos,
  zonaHoraria,
  bloqueado,
  onCambiar,
}: {
  tramos: TramoHorario[];
  zonaHoraria: string;
  bloqueado: boolean;
  onCambiar: (tramos: TramoHorario[]) => void;
}) {
  const porDia = new Map(tramos.map((tramo) => [tramo.weekday, tramo]));
  const errores = erroresDeSemana(tramos);
  const sinCobertura = diasSinCobertura(tramos);
  const nocturnos = tramos.filter((tramo) => cruzaMedianoche(tramo));

  function ordenar(lista: TramoHorario[]): TramoHorario[] {
    return [...lista].sort((a, b) => a.weekday - b.weekday);
  }

  function alternar(weekday: number, activo: boolean) {
    if (!activo) {
      onCambiar(tramos.filter((tramo) => tramo.weekday !== weekday));
      return;
    }
    // Se copia el primer dia ya configurado: la semana casi siempre se repite.
    const modelo = tramos[0] ?? TRAMO_SEMILLA;
    onCambiar(
      ordenar([
        ...tramos,
        { weekday, opensAt: modelo.opensAt, closesAt: modelo.closesAt },
      ]),
    );
  }

  function editar(weekday: number, campo: 'opensAt' | 'closesAt', valor: string) {
    onCambiar(
      tramos.map((tramo) => (tramo.weekday === weekday ? { ...tramo, [campo]: valor } : tramo)),
    );
  }

  return (
    <section className="management-card">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Evidencia</span>
          <h3>Horario hábil</h3>
        </div>
        <span className="status-pill">{tramos.length} de 7 días</span>
      </div>

      <p className="section-explanation">
        Las horas son de la zona horaria del recinto ({zonaHoraria}), no de tu computador ni del
        teléfono del guardia. Fuera de estos tramos la foto pasa a obligatoria en todos los puntos, si
        así lo dice la regla «Foto obligatoria fuera de horario».
      </p>

      <div className="hours-grid">
        {DIAS.map((dia, weekday) => {
          const tramo = porDia.get(weekday);
          return (
            <div className="hours-row" key={dia}>
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(tramo)}
                  disabled={bloqueado}
                  onChange={(evento) => alternar(weekday, evento.target.checked)}
                />
                {dia}
              </label>
              <input
                type="time"
                aria-label={`Apertura del ${dia.toLocaleLowerCase('es')}`}
                value={tramo?.opensAt ?? TRAMO_SEMILLA.opensAt}
                disabled={bloqueado || !tramo}
                onChange={(evento) => editar(weekday, 'opensAt', evento.target.value)}
              />
              <span>{tramo && cruzaMedianoche(tramo) ? '→ +1 día' : '—'}</span>
              <input
                type="time"
                aria-label={`Cierre del ${dia.toLocaleLowerCase('es')}`}
                value={tramo?.closesAt ?? TRAMO_SEMILLA.closesAt}
                disabled={bloqueado || !tramo}
                onChange={(evento) => editar(weekday, 'closesAt', evento.target.value)}
              />
            </div>
          );
        })}
      </div>

      {errores.size ? (
        <div className="reglas-aviso error" role="alert">
          <strong>Corrige esto antes de guardar</strong>
          <ul>
            {[...errores.entries()].map(([weekday, error]) => (
              <li key={weekday}>
                {nombreDia(weekday)}: {error}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {nocturnos.length ? (
        <div className="reglas-aviso" role="status">
          <strong>Tienes {nocturnos.length === 1 ? 'un turno' : 'turnos'} que cruza la medianoche</strong>
          <ul>
            {nocturnos.map((tramo) => (
              <li key={tramo.weekday}>
                {nombreDia(tramo.weekday)} {descripcionTramo(tramo)} — la madrugada siguiente se
                configura acá, en la fila del {nombreDia(tramo.weekday).toLocaleLowerCase('es')}.
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="form-note">Cobertura que queda por día</p>
      <div className="holiday-list">
        {DIAS.map((dia, weekday) => {
          const cobertura = coberturaDelDia(weekday, tramos);
          return (
            <span key={dia}>
              <strong>{dia}</strong>
              {cobertura.length
                ? cobertura.map((franja) => descripcionFranja(franja)).join(' · ')
                : 'fuera de horario todo el día'}
            </span>
          );
        })}
      </div>

      {/*
        Se decide por `tramos.length`, no por «7 días sin cobertura»: con siete
        tramos cargados pero invalidos (apertura = cierre) coberturaDelDia los
        descarta y tambien darian 7 — y ahi el recinto SI tiene horario cargado,
        solo que mal. Decir «sin ningún tramo cargado» en ese caso contradice al
        aviso de error que se muestra mas arriba.
      */}
      {tramos.length === 0 ? (
        <p className="form-note">
          Sin ningún tramo cargado, el recinto no decide nada: manda la regla «Recinto sin horario
          cargado cuenta como abierto».
        </p>
      ) : sinCobertura.length ? (
        <p className="form-note">
          Días fuera de horario completos:{' '}
          {sinCobertura.map((weekday) => nombreDia(weekday)).join(', ')}. En esos días se pedirá foto
          en todos los puntos.
        </p>
      ) : null}
    </section>
  );
}
