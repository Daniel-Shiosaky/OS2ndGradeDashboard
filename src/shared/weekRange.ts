// Isomorphic date helpers (no Node-specific APIs) shared by the frontend
// bundle and the backend pipeline scripts.

export interface WeekRange {
  weekStart: string; // YYYY-MM-DD, Sunday
  weekEnd: string; // YYYY-MM-DD, Saturday
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The calendar date an instant falls on in a given timezone, as YYYY-MM-DD.
 *
 * Reading `instant.toISOString()` instead is wrong for anyone west of UTC: a
 * ClassDojo post sent at 9:22pm in New York carries a UTC timestamp on the
 * following day, so it would be filed a day late. Falls back to UTC when the
 * configured zone is not recognised.
 */
export function dateInTimeZone(instant: Date, timeZone: string): string {
  try {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(instant);
  } catch {
    return toIsoDate(instant);
  }
}

/**
 * Same as `dateInTimeZone` for an ISO string, returning null rather than throwing
 * on unparseable input. Source feeds supply timestamps we do not control.
 */
export function isoDateInTimeZone(isoInstant: string, timeZone: string): string | null {
  const instant = new Date(isoInstant);
  return Number.isNaN(instant.getTime()) ? null : dateInTimeZone(instant, timeZone);
}

/** Today's calendar date in the school's timezone, as YYYY-MM-DD. */
export function todayInTimeZone(timeZone: string, now: Date = new Date()): string {
  return dateInTimeZone(now, timeZone);
}

/** Sunday-to-Saturday range containing the given YYYY-MM-DD date. */
export function weekRangeForDate(isoDate: string): WeekRange {
  const day = new Date(`${isoDate}T00:00:00Z`);
  const dayOfWeek = day.getUTCDay(); // 0 = Sunday
  const weekStart = new Date(day);
  weekStart.setUTCDate(day.getUTCDate() - dayOfWeek);
  const weekEnd = new Date(weekStart);
  weekEnd.setUTCDate(weekStart.getUTCDate() + 6);
  return { weekStart: toIsoDate(weekStart), weekEnd: toIsoDate(weekEnd) };
}

/** Returns the Sunday-to-Saturday week range containing `reference` (defaults to now, UTC). */
export function getCurrentWeekRange(reference: Date = new Date()): WeekRange {
  return weekRangeForDate(toIsoDate(startOfUtcDay(reference)));
}

/** Week range containing today in the school's timezone. */
export function getCurrentWeekRangeInTimeZone(timeZone: string, now: Date = new Date()): WeekRange {
  return weekRangeForDate(todayInTimeZone(timeZone, now));
}

export function isWithinRange(isoDate: string, range: WeekRange): boolean {
  return isoDate >= range.weekStart && isoDate <= range.weekEnd;
}

export function isAfterRange(isoDate: string, range: WeekRange): boolean {
  return isoDate > range.weekEnd;
}
