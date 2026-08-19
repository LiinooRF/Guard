'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

import { mondayOf, moveWeek, weekDates, weekdaySundayZero } from './schedule-week';

type Site = { id: string; name: string; branchName: string; timezone: string };
type Guard = { id: string; name: string; nfcCardUid?: string | null };
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
  const [editingGuardId, setEditingGuardId] = useState<string | null>(null);
  const [guardNfcInput, setGuardNfcInput] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dates = useMemo(() => weekDates(monday), [monday]);

  const assignmentsByDate = useMemo(() => {
    const map = new Map<string, Assignment[]>();
    for (const d of dates) {
      map.set(d, []);
    }
    for (const a of assignments) {
      const list = map.get(a.serviceDate);
      if (list) {
        list.push(a);
      } else {
        map.set(a.serviceDate, [a]);
      }
    }
    return map;
  }, [assignments, dates]);

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
      setGuards(nextGuards);
      setRoutes(nextRoutes.filter((route) => route.isActive));
      const activeShifts = nextShifts.filter((shift) => shift.isActive);
      setShifts(activeShifts);
      setSelectedShiftId((current) =>
        activeShifts.some((shift) => shift.id === current) ? current : activeShifts[0]?.id ?? '',
      );
      setAssignments(nextAssignments);
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [apiUrl, monday, siteId]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const data = await request<Site[]>(apiUrl, '/supervisor/sites');
        if (!alive) return;
        setSites(data);
        setSiteId((current) => current || data[0]?.id || '');
      } catch (cause) {
        if (alive) setError(messageOf(cause));
      }
    })();
    return () => {
      alive = false;
    };
  }, [apiUrl]);

  useEffect(() => {
    let alive = true;
    if (!siteId) return undefined;
    setError('');
    void (async () => {
      try {
        const [nextGuards, nextRoutes, nextShifts, nextAssignments] = await Promise.all([
          request<Guard[]>(apiUrl, `/supervisor/sites/${siteId}/guards`),
          request<Route[]>(apiUrl, `/supervisor/sites/${siteId}/routes`),
          request<Shift[]>(apiUrl, `/supervisor/sites/${siteId}/shifts`),
          request<Assignment[]>(apiUrl, `/supervisor/sites/${siteId}/schedule?from=${monday}`),
        ]);
        if (!alive) return;
        setGuards(nextGuards);
        setRoutes(nextRoutes.filter((route) => route.isActive));
        const activeShifts = nextShifts.filter((shift) => shift.isActive);
        setShifts(activeShifts);
        setSelectedShiftId((current) =>
          activeShifts.some((shift) => shift.id === current) ? current : activeShifts[0]?.id ?? '',
        );
        setAssignments(nextAssignments);
      } catch (cause) {
        if (alive) setError(messageOf(cause));
      }
    })();
    return () => {
      alive = false;
    };
  }, [apiUrl, monday, siteId]);

  async function createShift(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const rawWeekdays = form.getAll('weekday').map(Number);
    const weekdays = rawWeekdays.length ? rawWeekdays : [0, 1, 2, 3, 4, 5, 6];
    try {
      await request(apiUrl, `/supervisor/sites/${siteId}/shifts`, {
        method: 'POST', body: JSON.stringify({
          name: form.get('name'), startsAt: form.get('startsAt'), endsAt: form.get('endsAt'),
          weekdays,
        }),
      });
      setMessage('Turno reutilizable creado. Ya puedes seleccionarlo en el paso 2 para programar la semana.');
      formElement.reset(); await loadWeek();
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }

  async function saveGuardNfc(guardId: string) {
    setBusy(true); setError(''); setMessage('');
    try {
      await request(apiUrl, `/supervisor/guards/${guardId}/nfc-card`, {
        method: 'POST', body: JSON.stringify({ nfcCardUid: guardNfcInput.trim() || null }),
      });
      setMessage('Tarjeta NFC del guardia actualizada.');
      setEditingGuardId(null);
      setGuardNfcInput('');
      await loadWeek();
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }

  async function programWeek(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); setMessage('');
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const shiftId = String(form.get('shiftId'));
    const guardId = String(form.get('guardId'));
    const routeId = String(form.get('routeId'));
    const selectedDates = form.getAll('date').map(String);
    try {
      if (!selectedDates.length) throw new Error('Selecciona al menos un día de la semana.');
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
        await request(apiUrl, `/scheduling/generate`, {
          method: 'POST', body: JSON.stringify({ serviceDate, siteId }),
        }).catch(() => undefined);
      }
      setMessage(`${selectedDates.length} turnos y rondas programados sin solapamientos.`);
      await loadWeek();
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }

  async function reassign(assignmentId: string, guardId: string) {
    if (!guardId) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const assignment = assignments.find((a) => a.id === assignmentId);
      if (assignment) {
        const check = await request<{ conflict: boolean; message?: string }>(
          apiUrl, `/supervisor/shifts/${assignment.shiftId}/conflicts`, {
            method: 'POST', body: JSON.stringify({ guardId, serviceDate: assignment.serviceDate, assignmentId }),
          },
        );
        if (check.conflict) throw new Error(check.message ?? 'El guardia tiene un solapamiento.');
      }
      await request(apiUrl, `/supervisor/assignments/${assignmentId}`, {
        method: 'PATCH', body: JSON.stringify({ guardId }),
      });
      setMessage('Guardia reasignado.'); await loadWeek();
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }

  return (
    <section className="schedule-panel">
      <header className="card-heading">
        <div>
          <h2>Planificación</h2>
          <p>Programa turnos, recorridos y tareas de terreno.</p>
        </div>
        <select value={siteId} onChange={(event) => setSiteId(event.target.value)}>
          {!sites.length ? <option value="">Sin recintos asignados</option> : null}
          {sites.map((site) => <option key={site.id} value={site.id}>{site.name} ({site.branchName})</option>)}
        </select>
      </header>

      {error ? <p className="schedule-message error" role="alert">{error}</p> : null}
      {message ? <p className="schedule-message success">{message}</p> : null}

      {!siteId ? (
        <p className="schedule-empty">Selecciona un recinto para ver o crear turnos.</p>
      ) : (
        <>
          <nav className="schedule-week-nav">
            <button type="button" onClick={() => setMonday(moveWeek(monday, -1))}>← Semana anterior</button>
            <strong>{dates[0]} — {dates[6]}</strong>
            <button type="button" onClick={() => setMonday(moveWeek(monday, 1))}>Semana siguiente →</button>
          </nav>
          <div className="schedule-calendar" aria-label="Calendario semanal">
            {dates.map((date, index) => <div className="schedule-day" key={date}>
              <h3><span>{DAY_NAMES[index]}</span><small>{date.slice(8, 10)}</small></h3>
              {(assignmentsByDate.get(date) ?? []).map((a) => (
                <article key={a.id}>
                  <strong>{a.shiftName}</strong>
                  <span>{a.startsAt.slice(0, 5)}–{a.endsAt.slice(0, 5)}</span>
                  <small>{a.routeName ?? 'Sin ruta'}</small>
                  {a.status === 'asignado' && <select aria-label={`Reasignar ${a.shiftName}`} disabled={busy} defaultValue={a.guardId} onChange={(e) => void reassign(a.id, e.target.value)}>
                    {guards.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>}
                </article>
              ))}
            </div>)}
          </div>
          <div className="schedule-forms">
            <form onSubmit={createShift}>
              <h3>1. Crear ventana reutilizable</h3>
              <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '0.75rem' }}>
                Define la ventana de horario base (ej. Diurno 08:00 a 16:00 o Nocturno 22:00 a 06:00).
              </p>
              <label>Nombre del turno<input name="name" required minLength={2} placeholder="Ej: Diurno, Noche, Ronda Continua" /></label>
              <div className="schedule-inline"><label>Inicio<input name="startsAt" type="time" required /></label><label>Fin<input name="endsAt" type="time" required /></label></div>
              <fieldset><legend>Recurrencia semanal</legend>{DAY_NAMES.map((day, i) => <label key={day}><input type="checkbox" name="weekday" value={(i + 1) % 7} defaultChecked={i < 5} />{day}</label>)}</fieldset>
              <button disabled={busy || !siteId} type="submit">{busy ? 'Creando turno…' : 'Crear turno'}</button>
            </form>
            <form onSubmit={programWeek}>
              <h3>2. Programar semana completa</h3>
              <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '0.75rem' }}>
                Asigna el guardia, la ruta y la frecuencia horaria de rondas durante el turno.
              </p>
              <label>
                Turno reutilizable
                <select name="shiftId" required value={selectedShiftId} onChange={(event) => setSelectedShiftId(event.target.value)}>
                  {!shifts.length ? <option value="">⚠️ Primero crea un turno en el paso 1</option> : null}
                  {shifts.map((shift) => <option key={shift.id} value={shift.id}>{shift.name} · {shift.startsAt.slice(0, 5)}–{shift.endsAt.slice(0, 5)}</option>)}
                </select>
              </label>
              <label>
                Ruta a recorrer
                <select name="routeId" required>
                  {!routes.length ? <option value="">⚠️ Crea primero una ruta en el editor de abajo</option> : null}
                  {routes.map((route) => <option key={route.id} value={route.id}>{route.name}</option>)}
                </select>
              </label>
              <label>
                Guardia asignado
                <select name="guardId" required>
                  {!guards.length ? <option value="">⚠️ No hay guardias en este recinto</option> : null}
                  {guards.map((guard) => <option key={guard.id} value={guard.id}>{guard.name} {guard.nfcCardUid ? `(📇 ${guard.nfcCardUid})` : ''}</option>)}
                </select>
              </label>
              <div className="schedule-inline">
                <label title="Ej: 8 rondas en turno de 8 horas = 1 ronda por hora">
                  Rondas por turno
                  <input name="patrolsPerShift" type="number" min="1" max="48" defaultValue="1" required />
                </label>
                <label title="Separación mínima entre rondas consecutivas">
                  Separación mínima (min)
                  <input name="minGapMinutes" type="number" min="0" max="1440" defaultValue="0" required />
                </label>
              </div>
              <fieldset key={`${selectedShiftId}-${monday}`}><legend>Días de esta semana</legend>{dates.map((date, i) => <label key={date}><input type="checkbox" name="date" value={date} defaultChecked={shifts.find((shift) => shift.id === selectedShiftId)?.weekdays.includes(weekdaySundayZero(date)) ?? false} />{DAY_NAMES[i]}</label>)}</fieldset>
              <button disabled={busy || !shifts.length || !routes.length || !guards.length} type="submit">
                {busy ? 'Programando semana…' : !shifts.length ? 'Crea un turno en paso 1 primero' : !routes.length ? 'Crea una ruta activa primero' : !guards.length ? 'Sin guardias disponibles' : 'Revisar choques y programar'}
              </button>
            </form>
          </div>

          <div className="schedule-guard-nfc-section" style={{ marginTop: '2rem', padding: '1.25rem', backgroundColor: '#f8fafc', borderRadius: '0.75rem', border: '1px solid #e2e8f0' }}>
            <h3 style={{ fontSize: '1rem', fontWeight: 600, color: '#0f172a', marginBottom: '0.5rem' }}>📇 Tarjetas NFC de Guardias en este Recinto</h3>
            <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '1rem' }}>
              Asocia o actualiza el código físico de la tarjeta NFC de cada guardia para permitirles iniciar sesión con un solo toque en la app móvil.
            </p>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '0.75rem' }}>
              {guards.map((guard) => (
                <div key={guard.id} style={{ padding: '0.85rem', backgroundColor: '#ffffff', borderRadius: '0.5rem', border: '1px solid #cbd5e1', display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong style={{ fontSize: '0.9rem', color: '#0f172a' }}>{guard.name}</strong>
                    {guard.nfcCardUid ? (
                      <span style={{ fontSize: '0.75rem', backgroundColor: '#eff6ff', color: '#2563eb', padding: '0.25rem 0.5rem', borderRadius: '0.35rem', fontWeight: 600 }}>
                        📇 {guard.nfcCardUid}
                      </span>
                    ) : (
                      <span style={{ fontSize: '0.75rem', backgroundColor: '#f1f5f9', color: '#64748b', padding: '0.25rem 0.5rem', borderRadius: '0.35rem' }}>
                        Sin tarjeta
                      </span>
                    )}
                  </div>
                  {editingGuardId === guard.id ? (
                    <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.25rem', alignItems: 'center' }}>
                      <input
                        style={{ flex: 1, minHeight: '2.25rem', padding: '0.25rem 0.5rem', fontSize: '0.8rem', border: '1px solid #94a3b8', borderRadius: '0.35rem' }}
                        placeholder="Ej: 04A1B2C3D4"
                        value={guardNfcInput}
                        aria-label={`UID Tarjeta NFC para ${guard.name}`}
                        onChange={(e) => setGuardNfcInput(e.target.value)}
                      />
                      <button
                        style={{ minHeight: '2.25rem', padding: '0.25rem 0.75rem', fontSize: '0.8rem', fontWeight: 600, backgroundColor: '#2563eb', color: '#ffffff', border: 'none', borderRadius: '0.35rem', cursor: 'pointer' }}
                        disabled={busy}
                        onClick={() => void saveGuardNfc(guard.id)}
                      >
                        {busy ? '...' : 'Guardar'}
                      </button>
                      <button
                        style={{ minHeight: '2.25rem', padding: '0.25rem 0.6rem', fontSize: '0.8rem', backgroundColor: '#e2e8f0', color: '#334155', border: 'none', borderRadius: '0.35rem', cursor: 'pointer' }}
                        aria-label="Cancelar edición"
                        onClick={() => { setEditingGuardId(null); setGuardNfcInput(''); }}
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      style={{ alignSelf: 'flex-start', minHeight: '2rem', padding: '0.3rem 0.75rem', fontSize: '0.75rem', fontWeight: 600, backgroundColor: '#ffffff', color: '#2563eb', border: '1px solid #93c5fd', borderRadius: '0.35rem', cursor: 'pointer' }}
                      onClick={() => { setEditingGuardId(guard.id); setGuardNfcInput(guard.nfcCardUid ?? ''); }}
                    >
                      {guard.nfcCardUid ? 'Cambiar tarjeta NFC' : '+ Asignar tarjeta NFC'}
                    </button>
                  )}
                </div>
              ))}
            </div>
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
