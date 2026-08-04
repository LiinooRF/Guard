export interface ScheduleWindow {
  serviceDate: string;
  startsAt: string;
  endsAt: string;
}

export function mondayOf(value: Date): string {
  const date = new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  const offset = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - offset);
  return isoDate(date);
}

export function weekDates(monday: string): string[] {
  const base = new Date(`${monday}T00:00:00Z`);
  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(base);
    date.setUTCDate(base.getUTCDate() + index);
    return isoDate(date);
  });
}

export function moveWeek(monday: string, weeks: number): string {
  const date = new Date(`${monday}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + weeks * 7);
  return isoDate(date);
}

export function weekdaySundayZero(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function windowsOverlap(a: ScheduleWindow, b: ScheduleWindow): boolean {
  const [aStart, aEnd] = bounds(a);
  const [bStart, bEnd] = bounds(b);
  return aStart < bEnd && bStart < aEnd;
}

function bounds(window: ScheduleWindow): [number, number] {
  const start = Date.parse(`${window.serviceDate}T${normalizeTime(window.startsAt)}Z`);
  let end = Date.parse(`${window.serviceDate}T${normalizeTime(window.endsAt)}Z`);
  if (end <= start) end += 86_400_000;
  return [start, end];
}

function normalizeTime(value: string): string {
  return value.length === 5 ? `${value}:00` : value;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
