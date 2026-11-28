// Turns the school calendar's iCalendar feed into dashboard events.
//
// SPECIAL EVENTS ONLY. A MyOS calendar can carry far more than parents need: the
// daily class timetable (Language Arts, Math, PE, Lunch every day), club
// practices, and athletic fixtures. Publishing those would bury the handful of
// things worth knowing about — a concert, a field trip, an early release, a
// no-school day. Under-publishing is recoverable; a wall of recurring entries is
// not useful, and a timetable row carries a child's name onto a public page.
//
// An item is kept only when it is a one-off school event. It is dropped when it:
//   - belongs to a recurring series (RRULE, or the same title appearing many times),
//   - looks like a class period or timetable row,
//   - is a practice, rehearsal or athletic fixture,
//   - is cancelled, or long past.
// An item that names a configured child is WITHHELD whole, never trimmed.

import { mentionsAnyName, mustDropLine, redactPersonalNames } from "./redact.js";
import { parseIcal, type IcalDateTime, type IcalEvent } from "./parseIcal.js";
import { todayInTimeZone } from "./weekRange.js";
import type { Category, ExtractedEvent, Importance } from "../types/schema.js";

/** The same title this many times in one feed means a series, not a one-off. */
export const RECURRING_TITLE_THRESHOLD = 4;

/** Past events older than this are not published; the feed reaches back ~2 months. */
const STALE_AFTER_DAYS = 14;

export type CalendarWithheldReason =
  | "recurring"
  | "class-period"
  | "routine"
  | "cancelled"
  | "stale"
  | "names-child"
  | "contact-details";

export interface ParseCalendarOptions {
  timeZone: string;
  extraNames?: string[];
  /** YYYY-MM-DD in the school's zone; defaults to today. Fixed in tests. */
  today?: string;
}

export interface ParseCalendarResult {
  events: ExtractedEvent[];
  withheld: Record<CalendarWithheldReason, number>;
}

function emptyWithheld(): Record<CalendarWithheldReason, number> {
  return {
    recurring: 0,
    "class-period": 0,
    routine: 0,
    cancelled: 0,
    stale: 0,
    "names-child": 0,
    "contact-details": 0,
  };
}

/* ---------- classification ---------- */

/**
 * A timetable row, e.g. "Language Arts - 2A (2ELA)" or "Math - 2A (2MATH)".
 * These come from a student's own Schedule calendar, not the school-wide one,
 * but the filter does not rely on which feed it was handed.
 */
const CLASS_PERIOD = /\s-\s\d[A-Z]\b|\(\s*\d[A-Z][A-Z0-9-]*\s*\)\s*$/;

/** Practices, rehearsals, and athletic fixtures ("Team v Opponent", "Team @ Place"). */
const ROUTINE = /\b(?:practice|rehearsal|cafe\s+closed|cafeteria\s+closed)\b|\s(?:v|vs\.?)\s|\s@\s/i;

function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function classifyCalendarTitle(title: string): Category {
  const text = title.toLowerCase();
  if (/\bfield trip\b/.test(text)) return "field_trip";
  if (/\bno school\b|\bholiday\b|\bbreak\b|\bvacation\b|\bteacher (?:work\s?)?day\b/.test(text)) return "no_school";
  if (/\bearly (?:release|dismissal)\b|\bhalf day\b|\bdismissal\b/.test(text)) return "early_dismissal";
  if (/\bconcert\b|\bperformance\b|\bshow\b|\bspectacular\b|\brecital\b|\bopen mic\b|\bplay\b|\bmusical\b/.test(text)) {
    return "performance";
  }
  return "event";
}

function importanceFor(category: Category): Importance {
  return category === "no_school" || category === "early_dismissal" || category === "field_trip" ? "high" : "medium";
}

/* ---------- date and time ---------- */

interface LocalMoment {
  date: string;
  /** Minutes after midnight, or null for an all-day item. */
  minutes: number | null;
}

function partsInZone(instant: Date, timeZone: string): LocalMoment {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "00";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

/** The instant at which `date` `time` is the wall-clock reading in `timeZone`. */
function wallClockToInstant(date: string, time: string, timeZone: string): Date {
  const asUtc = new Date(`${date}T${time}:00Z`);
  // The zone's offset depends on the instant itself, so settle it in two passes.
  let instant = asUtc;
  for (let pass = 0; pass < 2; pass++) {
    const shown = partsInZone(instant, timeZone);
    const shownUtc = new Date(`${shown.date}T${String(Math.floor(shown.minutes! / 60)).padStart(2, "0")}:${String(shown.minutes! % 60).padStart(2, "0")}:00Z`);
    instant = new Date(instant.getTime() - (shownUtc.getTime() - asUtc.getTime()));
  }
  return instant;
}

function toSchoolMoment(moment: IcalDateTime, timeZone: string): LocalMoment | null {
  try {
    if (moment.kind === "date") return { date: moment.date, minutes: null };
    if (moment.kind === "utc") return partsInZone(moment.instant, timeZone);
    const [hours, minutes] = moment.time.split(":").map(Number);
    if (!moment.timeZone || moment.timeZone === timeZone) {
      return { date: moment.date, minutes: (hours ?? 0) * 60 + (minutes ?? 0) };
    }
    return partsInZone(wallClockToInstant(moment.date, moment.time, moment.timeZone), timeZone);
  } catch {
    // An unrecognised zone name must not take the whole feed down.
    return null;
  }
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function clock(minutes: number): { text: string; period: "AM" | "PM" } {
  const hours24 = Math.floor(minutes / 60) % 24;
  const period = hours24 >= 12 ? "PM" : "AM";
  const hours12 = ((hours24 + 11) % 12) + 1;
  return { text: `${hours12}:${String(minutes % 60).padStart(2, "0")}`, period };
}

/** "6:00-7:00 PM" when both ends share AM/PM, otherwise "11:30 AM - 1:00 PM". */
export function formatTimeRange(startMinutes: number, endMinutes: number | null): string {
  const start = clock(startMinutes);
  if (endMinutes === null || endMinutes === startMinutes) return `${start.text} ${start.period}`;
  const end = clock(endMinutes);
  return start.period === end.period
    ? `${start.text}–${end.text} ${end.period}`
    : `${start.text} ${start.period} – ${end.text} ${end.period}`;
}

/* ---------- the parser ---------- */

export function parseCalendarFeed(icalText: string, options: ParseCalendarOptions): ParseCalendarResult {
  const { timeZone, extraNames = [] } = options;
  const today = options.today ?? todayInTimeZone(timeZone);
  const staleBefore = addDays(today, -STALE_AFTER_DAYS);
  const withheld = emptyWithheld();
  const events: ExtractedEvent[] = [];
  // Start time of each event, so same-day items sort by when they happen.
  const startMinutes = new Map<ExtractedEvent, number>();
  const seen = new Set<string>();

  const feed = parseIcal(icalText);

  // A series is spotted by how often its title repeats across the whole feed,
  // before any other filter, so one cancelled instance cannot hide the series.
  const titleCounts = new Map<string, number>();
  for (const item of feed) {
    const key = normaliseTitle(item.summary);
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }

  for (const item of feed) {
    const title = item.summary.trim();
    if (!title) continue;

    if (item.status === "CANCELLED") {
      withheld.cancelled++;
      continue;
    }
    if (item.recurring || (titleCounts.get(normaliseTitle(title)) ?? 0) >= RECURRING_TITLE_THRESHOLD) {
      withheld.recurring++;
      continue;
    }
    if (CLASS_PERIOD.test(title)) {
      withheld["class-period"]++;
      continue;
    }
    if (ROUTINE.test(title)) {
      withheld.routine++;
      continue;
    }

    // Withheld whole when a child is named anywhere in the entry.
    if (mentionsAnyName(`${title}\n${item.location}\n${item.description}`, extraNames)) {
      withheld["names-child"]++;
      continue;
    }
    if (mustDropLine(title)) {
      withheld["contact-details"]++;
      continue;
    }

    const start = toSchoolMoment(item.start, timeZone);
    if (!start) continue;
    const end = item.end ? toSchoolMoment(item.end, timeZone) : null;

    // An all-day item's DTEND is the day *after* its last day.
    const lastDay = item.start.kind === "date" && end ? addDays(end.date, -1) : start.date;
    if (lastDay < staleBefore) {
      withheld.stale++;
      continue;
    }

    const category = classifyCalendarTitle(title);
    const time =
      start.minutes === null ? null : formatTimeRange(start.minutes, end && end.date === start.date ? end.minutes : null);

    const details: string[] = [];
    if (item.location) details.push(`Location: ${item.location}`);
    const body = item.description
      .split(/\r?\n/)
      .filter((line) => !(line.trim() && mustDropLine(line)))
      .join("\n")
      .trim();
    if (body) details.push(redactPersonalNames(body, extraNames));

    const key = `${normaliseTitle(title)}|${start.date}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const built: ExtractedEvent = {
      date: start.date,
      ...(lastDay > start.date ? { end_date: lastDay } : {}),
      time,
      title: redactPersonalNames(title, extraNames),
      category,
      description: details.join(" · "),
      importance: importanceFor(category),
      uncertain: false,
    };
    events.push(built);
    startMinutes.set(built, start.minutes ?? -1);
  }

  // All-day items first, then by start time, then by title.
  events.sort(
    (first, second) =>
      first.date.localeCompare(second.date) ||
      (startMinutes.get(first) ?? -1) - (startMinutes.get(second) ?? -1) ||
      first.title.localeCompare(second.title),
  );
  return { events, withheld };
}

/** Compact "3 recurring, 2 routine" summary for the run log. */
export function summariseCalendarWithheld(withheld: Record<CalendarWithheldReason, number>): string {
  return Object.entries(withheld)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${count} ${reason}`)
    .join(", ");
}

export type { IcalEvent };
