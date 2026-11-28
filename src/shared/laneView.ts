// Which items the ClassDojo and Email lanes put on the dashboard cards.
//
// These lanes used to show everything ever collected: a calendar event from
// September sat at the top of "Upcoming" and pushed the real upcoming items out
// of the row cap, and September teacher emails still headed the Email lane. The
// cards now follow the active newsletter week instead. The full history is still
// available behind "Open all".
//
// Isomorphic (no Node APIs): used by the frontend bundle and tested directly.

import { resolveMonthDay } from "./newsletter.js";
import { weekRangeForDate } from "./weekRange.js";

/** How far back from the active week a message still counts as recent. */
export const RECENT_WINDOW_DAYS = 28;

export interface ActiveWeek {
  weekStart: string;
  weekEnd: string;
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const WEEK_LABEL = /^\s*(\d{1,2})\/(\d{1,2})\s*[-–]\s*(\d{1,2})\/(\d{1,2})\s*$/;

/**
 * The week the published newsletter covers ("11/30-12/4"). It is usually the
 * coming week, not the one containing today, because the newsletter goes out
 * ahead of time. The label has no year, so each end is resolved against today.
 * Falls back to the week containing today when there is no usable label.
 */
export function activeNewsletterWeek(weekLabel: string | undefined, todayIso: string): ActiveWeek {
  const today = new Date(`${todayIso}T12:00:00Z`);
  const match = weekLabel?.match(WEEK_LABEL);
  if (match) {
    const weekStart = resolveMonthDay(Number(match[1]), Number(match[2]), today);
    const weekEnd = resolveMonthDay(Number(match[3]), Number(match[4]), today);
    if (weekStart && weekEnd && weekStart <= weekEnd) return { weekStart, weekEnd };
  }
  return weekRangeForDate(todayIso);
}

/** Minimal shape needed here, so tests do not have to build a full event. */
export interface FeedItem {
  date: string;
  end_date?: string;
  category: string;
}

/**
 * True when a ClassDojo or Email item belongs on the dashboard card.
 *
 * - A dated item (calendar event, field trip, no-school day) must not be in the
 *   past: it is forward-looking, so yesterday's event is noise.
 * - A message (announcement) is kept for RECENT_WINDOW_DAYS before the active
 *   week starts, and always if it is newer than that. Older ones stay in
 *   "Open all".
 */
export function isCurrentFeedItem(item: FeedItem, week: ActiveWeek, todayIso: string): boolean {
  if (item.category === "announcement") {
    return item.date >= addDays(week.weekStart, -RECENT_WINDOW_DAYS);
  }
  // A multi-day event is still current until its last day.
  return (item.end_date ?? item.date) >= todayIso;
}

/**
 * The value a row's date label is formatted from.
 *
 * A message shows when it arrived, which is a real instant and so needs the school
 * timezone. A dated item (calendar event, no-school day) shows its own `date`: its
 * `received_at` is just the event's start, and for an all-day event that is UTC
 * midnight, which falls on the *previous* evening in New York — converting it
 * labelled the Dec 4 early release "Dec 3".
 */
export function dateLabelSource(item: FeedItem & { received_at?: string }): string {
  return item.category === "announcement" ? (item.received_at ?? item.date) : item.date;
}

/**
 * Sort key for a time label such as "6:00-7:00 PM", "11:30 AM - 1:00 PM" or
 * "12:10 PM": minutes after midnight of the START, or -1 for an all-day item so
 * those list first. The period is read from the first AM/PM anywhere in the
 * label, because "6:00-7:00 PM" only prints it once.
 */
export function timeSortKey(time: string | null | undefined): number {
  if (!time) return -1;
  const clock = time.match(/(\d{1,2}):(\d{2})/);
  if (!clock) return -1;
  const period = time.match(/\b(AM|PM)\b/i)?.[1]?.toUpperCase();
  let hours = Number(clock[1]) % 12;
  if (period === "PM") hours += 12;
  return hours * 60 + Number(clock[2]);
}

/** Last day an item is still relevant: the end of a multi-day event, else its date. */
export function lastDayOf(item: { date: string; end_date?: string }): string {
  return item.end_date ?? item.date;
}

/** How far ahead the Calendar card looks. Later items are under "Open all". */
export const CALENDAR_HORIZON_DAYS = 21;

/**
 * True when a calendar item starts within the card's horizon (or has already
 * started and is still running). The card lists everything in that window
 * instead of a row cap: a capped, section-rotated list filled up with early
 * December items and left the Dec 15 concert off the card entirely.
 */
export function isWithinCalendarHorizon(item: { date: string }, todayIso: string): boolean {
  return item.date <= addDays(todayIso, CALENDAR_HORIZON_DAYS);
}
