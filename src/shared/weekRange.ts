// Isomorphic date helpers (no Node-specific APIs) shared by the frontend
// bundle and the backend pipeline scripts.

export interface WeekRange {
  weekStart: string; // YYYY-MM-DD, Sunday
  weekEnd: string; // YYYY-MM-DD, Saturday
}

function toDateOnly(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Returns the Sunday-to-Saturday week range containing `reference` (defaults to now, UTC). */
export function getCurrentWeekRange(reference: Date = new Date()): WeekRange {
  const day = toDateOnly(reference);
  const dayOfWeek = day.getUTCDay(); // 0 = Sunday
  const start = new Date(day);
  start.setUTCDate(day.getUTCDate() - dayOfWeek);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { weekStart: formatDate(start), weekEnd: formatDate(end) };
}

export function isWithinRange(dateStr: string, range: WeekRange): boolean {
  return dateStr >= range.weekStart && dateStr <= range.weekEnd;
}

export function isAfterRange(dateStr: string, range: WeekRange): boolean {
  return dateStr > range.weekEnd;
}
