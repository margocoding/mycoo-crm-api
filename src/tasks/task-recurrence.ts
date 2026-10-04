export const TASK_DAY = 86_400_000;
const MOSCOW_OFFSET = 3 * 3_600_000;

// Task dates are calendar dates; a scheduled occurrence is created at midnight Moscow time.
export function recurrenceDate(at: Date) {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(at);
}

export function nextRecurrence(days: number[], afterDate: string): Date | null {
  if (!days.length) return null;
  const date = new Date(afterDate);
  for (let i = 0; i < 7; i++) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay() || 7;
    if (days.includes(weekday)) return new Date(date.getTime() - MOSCOW_OFFSET);
  }
  return null;
}

export function scheduleRecurrence(days: number[], startDate: string, now = new Date()) {
  const today = recurrenceDate(now);
  return nextRecurrence(days, startDate > today ? startDate : today);
}
