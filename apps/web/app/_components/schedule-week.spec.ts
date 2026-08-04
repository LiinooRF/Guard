import { mondayOf, moveWeek, weekDates, weekdaySundayZero, windowsOverlap } from './schedule-week';

describe('calendario semanal', () => {
  it('arma siempre una semana lunes a domingo sin depender del huso del navegador', () => {
    expect(mondayOf(new Date(2026, 7, 6))).toBe('2026-08-03');
    expect(weekDates('2026-08-03')).toEqual([
      '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06',
      '2026-08-07', '2026-08-08', '2026-08-09',
    ]);
    expect(moveWeek('2026-08-03', 1)).toBe('2026-08-10');
    expect(weekdaySundayZero('2026-08-09')).toBe(0);
  });

  it('detecta cruces nocturnos y permite ventanas contiguas', () => {
    const night = { serviceDate: '2026-08-03', startsAt: '22:00', endsAt: '06:00' };
    expect(windowsOverlap(night, {
      serviceDate: '2026-08-04', startsAt: '05:30', endsAt: '09:00',
    })).toBe(true);
    expect(windowsOverlap(night, {
      serviceDate: '2026-08-04', startsAt: '06:00', endsAt: '14:00',
    })).toBe(false);
  });
});
