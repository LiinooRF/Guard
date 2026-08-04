'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { mondayOf, moveWeek, weekDates, weekdaySundayZero } from './schedule-week';

type Site = { id: string; name: string; branchName: string; timezone: string };
type Guard = { id: string; name: string };
type Route = { id: string; name: string; estimatedDurationMin: number; isActive: boolean };
type Shift = {
  id: string; name: string; startsAt: string; endsAt: string; weekdays: number[];
  crossesMidnight: boolean; isActive: boolean;
};
type Assignment = {
  id: string; shiftId: string; shiftName: string; startsAt: string; endsAt: string;
  serviceDate: string; guardId: string; guardName: string; status: string;
  routeName: string | null;
};

const DAY_NAMES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

export function SupervisorSchedule({ apiUrl }: { apiUrl: string }) {
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState('');
  const [monday, setMonday] = useState(() => mondayOf(new Date()));
  const [guards, setGuards] = useState<Guard[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [selectedShiftId, setSelectedShiftId] = useState('');
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dates = useMemo(() => weekDates(monday), [monday]);

  const loadSites = useCallback(async () => {
    try {
      const data = await request<Site[]>(apiUrl, '/supervisor/sites');
      setSites(data);
      setSiteId((current) => current || data[0]?.id || '');
    } catch (cause) { setError(messageOf(cause)); }
  }, [apiUrl]);

  const loadWeek = useCallback(async () => {
    if (!siteId) return;
    setError('');
    try {
      const [nextGuards, nextRoutes, nextShifts, nextAssignments] = await Promise.all([
        request<Guard[]>(apiUrl, `/supervisor/sites/${siteId}/guards`),
        request<Route[]>(apiUrl, `/supervisor/sites/${siteId}/routes`),
        request<Shift[]>(apiUrl, `/supervisor/sites/${siteId}/shifts`),
        request<Assignment[]>(apiUrl, `/supervisor/sites/${siteId}/schedule?from=${monday}`),
      ]);
      setGuards(nextGuards); setRoutes(nextRoutes.filter((route) => route.isActive));
      const activeShifts = nextShifts.filter((shift) => shift.isActive);
      setShifts(activeShifts);
      setSelectedShiftId((current) => activeShifts.some((shift) => shift.id === current) ? current : activeShifts[0]?.id ?? '');
      setAssignments(nextAssignments);
    } catch (cause) { setError(messageOf(cause)); }
  }, [apiUrl, monday, siteId]);

  useEffect(() => { void loadSites(); }, [loadSites]);
  useEffect(() => { void loadWeek(); }, [loadWeek]);

  async function createShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    const form = new FormData(event.currentTarget);
    const weekdays = form.getAll('weekday').map(Number);
    try {
      await request(apiUrl, `/supervisor/sites/${siteId}/shifts`, {
        method: 'POST', body: JSON.stringify({
          name: form.get('name'), startsAt: form.get('startsAt'), endsAt: form.get('endsAt'),
          weekdays,
        }),
      });
      setMessage('Turno reutilizable creado. Ya puedes programarlo en esta semana.');
      event.currentTarget.reset(); await loadWeek();
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }

  async function programWeek(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    const form = new FormData(event.currentTarget);
    const shiftId = String(form.get('shiftId'));
    const guardId = String(form.get('guardId'));
    const routeId = String(form.get('routeId'));
    const selectedDates = form.getAll('date').map(String);
    try {
      if (!selectedDates.length) throw new Error('Selecciona al menos un día de la semana.');
      // Preflight explícito: ningún PUT/POST de programación ocurre si una fecha choca.
      for (const serviceDate of selectedDates) {
        const check = await request<{ conflict: boolean; message?: string }>(
          apiUrl, `/supervisor/shifts/${shiftId}/conflicts`, {
            method: 'POST', body: JSON.stringify({ guardId, serviceDate }),
          },
        );
        if (check.conflict) throw new Error(check.message ?? 'El guardia tiene un solapamiento.');
      }
      await request(apiUrl, `/scheduling/shifts/${shiftId}/patterns`, {
        method: 'PUT', body: JSON.stringify({ patterns: [{
          routeId, patrolsPerShift: Number(form.get('patrolsPerShift')),
          minGapMinutes: Number(form.get('minGapMinutes')),
        }] }),
      });
      for (const serviceDate of selectedDates) {
        await request(apiUrl, `/supervisor/shifts/${shiftId}/assignments`, {
          method: 'POST', body: JSON.stringify({ guardId, serviceDate }),
        });
      }
      setMessage(`${selectedDates.length} turno(s) programado(s) sin solapamientos.`);
      await loadWeek();
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }

  async function reassign(assignment: Assignment, guardId: string) {
    if (!guardId || guardId === assignment.guardId) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const check = await request<{ conflict: boolean; message?: string }>(
        apiUrl, `/supervisor/shifts/${assignment.shiftId}/conflicts`, {
          method: 'POST', body: JSON.stringify({ guardId, serviceDate: assignment.serviceDate }),
        },
      );
      if (check.conflict) throw new Error(check.message ?? 'El reemplazo tiene un solapamiento.');
      await request(apiUrl, `/supervisor/assignments/${assignment.id}`, {
        method: 'PATCH', body: JSON.stringify({ guardId }),
      });
      setMessage('Guardia reasignado.'); await loadWeek();
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }

  return (
    <section className="management-card management-wide schedule-panel" id="turnos">
      <div className="card-heading">
        <div><span className="eyebrow">Planificación</span><h2>Turnos de la semana</h2></div>
        <select aria-label="Recinto" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
          {sites.map((site) => <option key={site.id} value={site.id}>{site.branchName} · {site.name}</option>)}
        </select>
      </div>
      {!sites.length ? <div className="dashboard-empty"><strong>Sin recintos asignados</strong><span>Un administrador debe asignarte al menos uno.</span></div> : (
        <>
          <div className="schedule-week-nav">
            <button type="button" onClick={() => setMonday(moveWeek(monday, -1))}>← Semana anterior</button>
            <strong>{dates[0]} — {dates[6]}</strong>
            <button type="button" onClick={() => setMonday(moveWeek(monday, 1))}>Semana siguiente →</button>
          </div>
          {error && <p className="schedule-message error" role="alert">{error}</p>}
          {message && <p className="schedule-message success" role="status">{message}</p>}
          <div className="schedule-calendar" aria-label="Calendario semanal">
            {dates.map((date, index) => <div className="schedule-day" key={date}>
              <h3>{DAY_NAMES[index]}<small>{date.slice(8, 10)}</small></h3>
              {assignments.filter((a) => a.serviceDate === date).map((assignment) => (
                <article key={assignment.id}>
                  <strong>{assignment.startsAt.slice(0, 5)}–{assignment.endsAt.slice(0, 5)}</strong>
                  <span>{assignment.shiftName}</span><small>{assignment.routeName ?? 'Sin ruta'} · {assignment.guardName}</small>
                  {assignment.status === 'asignado' && <select aria-label={`Reasignar ${assignment.shiftName}`} disabled={busy} value={assignment.guardId} onChange={(e) => void reassign(assignment, e.target.value)}>
                    {guards.map((guard) => <option key={guard.id} value={guard.id}>{guard.name}</option>)}
                  </select>}
                </article>
              ))}
            </div>)}
          </div>
          <div className="schedule-forms">
            <form onSubmit={createShift}><h3>1. Crear ventana reutilizable</h3>
              <label>Nombre<input name="name" required minLength={2} placeholder="Nocturno" /></label>
              <div className="schedule-inline"><label>Inicio<input name="startsAt" type="time" required /></label><label>Fin<input name="endsAt" type="time" required /></label></div>
              <fieldset><legend>Recurrencia</legend>{DAY_NAMES.map((day, i) => <label key={day}><input type="checkbox" name="weekday" value={(i + 1) % 7} defaultChecked={i < 5} />{day}</label>)}</fieldset>
              <button disabled={busy || !siteId} type="submit">Crear turno</button>
            </form>
            <form onSubmit={programWeek}><h3>2. Programar semana completa</h3>
              <label>Turno<select name="shiftId" required value={selectedShiftId} onChange={(event) => setSelectedShiftId(event.target.value)}>{shifts.map((shift) => <option key={shift.id} value={shift.id}>{shift.name} · {shift.startsAt.slice(0, 5)}–{shift.endsAt.slice(0, 5)}</option>)}</select></label>
              <label>Ruta<select name="routeId" required>{routes.map((route) => <option key={route.id} value={route.id}>{route.name}</option>)}</select></label>
              <label>Guardia<select name="guardId" required>{guards.map((guard) => <option key={guard.id} value={guard.id}>{guard.name}</option>)}</select></label>
              <div className="schedule-inline"><label>Rondas por turno<input name="patrolsPerShift" type="number" min="1" max="48" defaultValue="1" required /></label><label>Separación mínima<input name="minGapMinutes" type="number" min="0" max="1440" defaultValue="0" required /></label></div>
              <fieldset key={`${selectedShiftId}-${monday}`}><legend>Días de esta semana</legend>{dates.map((date, i) => <label key={date}><input type="checkbox" name="date" value={date} defaultChecked={shifts.find((shift) => shift.id === selectedShiftId)?.weekdays.includes(weekdaySundayZero(date)) ?? false} />{DAY_NAMES[i]}</label>)}</fieldset>
              <button disabled={busy || !shifts.length || !routes.length || !guards.length} type="submit">Revisar choques y programar</button>
            </form>
          </div>
        </>
      )}
    </section>
  );
}

async function request<T = unknown>(apiUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init, credentials: 'include', headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { message?: string | string[] } | null;
    throw new Error(Array.isArray(body?.message) ? body.message.join('. ') : body?.message ?? `Error ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function messageOf(cause: unknown): string { return cause instanceof Error ? cause.message : 'No pudimos completar la operación.'; }
