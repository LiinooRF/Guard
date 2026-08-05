'use client';

/**
 * Feriados y cierres especiales de un recinto (#68).
 *
 * No hay calendario chileno cargado a proposito: un recinto puede operar un
 * feriado legal y cerrar otro dia por mantencion. Cada fila significa "dia no
 * habil", y apaga el DIA CALENDARIO local completo — incluida la madrugada que
 * venia del turno nocturno del dia anterior. Al reves no: marcar el viernes no
 * apaga la madrugada del sabado, porque el servidor compara el feriado contra
 * la fecha local del instante escaneado.
 */
import { useState } from 'react';

import { diaDeLaSemana, nombreDia, type FeriadoRecinto } from './horario-habil-modelo';

export function HorarioHabilFeriados({
  feriados,
  zonaHoraria,
  bloqueado,
  onCambiar,
}: {
  feriados: FeriadoRecinto[];
  zonaHoraria: string;
  bloqueado: boolean;
  onCambiar: (feriados: FeriadoRecinto[]) => void;
}) {
  const [fecha, setFecha] = useState('');
  const [motivo, setMotivo] = useState('');

  const repetida = feriados.some((feriado) => feriado.date === fecha);
  const fechaValida = diaDeLaSemana(fecha) !== null;
  // El servidor exige entre 2 y 120 caracteres cuando el motivo viene escrito.
  const motivoCorto = motivo.trim().length === 1;

  function agregar() {
    if (!fechaValida || repetida || motivoCorto) return;
    onCambiar(
      [...feriados, { date: fecha, name: motivo.trim() || null }].sort((a, b) =>
        a.date.localeCompare(b.date),
      ),
    );
    setFecha('');
    setMotivo('');
  }

  return (
    <section className="management-card management-wide">
      <div className="card-heading">
        <div>
          <span className="eyebrow">Calendario</span>
          <h3>Feriados y cierres especiales</h3>
        </div>
        <span className="status-pill">{feriados.length} fechas</span>
      </div>

      <p className="section-explanation">
        Cada fecha se lee en la zona horaria del recinto ({zonaHoraria}) y vale sólo para este
        recinto. Un feriado se comporta como día no hábil completo: de 00:00 a 24:00 se pide foto en
        todos los puntos, aunque ese día tuviera tramo cargado y aunque viniera cubierto por el turno
        nocturno del día anterior.
      </p>

      <div className="holiday-add">
        <input
          type="date"
          aria-label="Fecha del feriado"
          value={fecha}
          disabled={bloqueado}
          onChange={(evento) => setFecha(evento.target.value)}
        />
        <input
          placeholder="Motivo (opcional)"
          aria-label="Motivo del feriado"
          maxLength={120}
          value={motivo}
          disabled={bloqueado}
          onChange={(evento) => setMotivo(evento.target.value)}
        />
        <button
          className="secondary-button"
          type="button"
          disabled={bloqueado || !fechaValida || repetida || motivoCorto}
          onClick={agregar}
        >
          Agregar fecha
        </button>
      </div>

      {repetida ? <p className="form-note">Esa fecha ya está en la lista.</p> : null}
      {motivoCorto ? <p className="form-note">El motivo necesita al menos 2 caracteres, o déjalo vacío.</p> : null}

      {feriados.length ? (
        <div className="holiday-list">
          {feriados.map((feriado) => {
            const weekday = diaDeLaSemana(feriado.date);
            return (
              <span key={feriado.date}>
                {feriado.date}
                {weekday === null ? '' : ` · ${nombreDia(weekday)}`}
                {feriado.name ? ` · ${feriado.name}` : ''}
                <button
                  type="button"
                  aria-label={`Quitar ${feriado.date}`}
                  disabled={bloqueado}
                  onClick={() => onCambiar(feriados.filter((item) => item.date !== feriado.date))}
                >
                  ×
                </button>
              </span>
            );
          })}
        </div>
      ) : (
        <div className="dashboard-empty">
          <strong>Sin feriados cargados</strong>
          <span>
            Mientras no haya ninguno, todos los días se rigen sólo por el horario semanal de arriba.
          </span>
        </div>
      )}
    </section>
  );
}
