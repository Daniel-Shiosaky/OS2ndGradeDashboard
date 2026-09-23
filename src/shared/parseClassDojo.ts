// Extractors for the ClassDojo parent app, reading its JSON APIs rather than
// scraping the rendered page.
//
//   /api/parentCalendarEvent?limit=50&hidePastEvents=true
//   /api/storyFeed?withStudentCommentsAndLikes=false&withSyntheticPosts=false
//
// Using the APIs removes every heuristic the DOM version needed: dates arrive as
// `startDate` (already YYYY-MM-DD) and `time` (a full ISO timestamp) instead of
// "15 minutes ago" or a bare "Sep 21"; post text arrives as `contents.body`
// instead of text mixed with nav chrome, photo counters and Like/Comment
// footers; and past events are filtered server-side.
//
// Two query parameters are deliberate:
//   withStudentCommentsAndLikes=false — comments are written by other parents
//     and children. Not requesting them means their names never reach this
//     process at all, which is a stronger guarantee than redacting them later.
//   withSyntheticPosts=false — drops the "CLASS EVENT" reposts that duplicate
//     the calendar feed.
//
// Personal data still reaches us in the response: every item carries `teacher`,
// `senderName`, `headerText`, `headerSubtext` and `classroom.name` (e.g.
// "Mrs. Rivera's Class"). None of those fields are read. Only titles, dates,
// descriptions and post bodies are, and those still go through redact.ts —
// bodies quote family surnames such as "courtesy of the Testfamily family".

import { mustDropLine, redactPersonalNames } from "./redact.js";
import { looksSchoolRelevant } from "./relevance.js";
import { isoDateInTimeZone } from "./weekRange.js";
import type { Category, ExtractedEvent } from "../types/schema.js";

/** Marks a post the feed generated from a calendar event rather than a teacher writing it. */
const SYNTHETIC_EVENT_BODY = /^-{5,}\s*\n\s*CLASS EVENT/i;

function classifyEvent(text: string): Category {
  const haystack = text.toLowerCase();
  if (/\bquiz\b/.test(haystack)) return "quiz";
  if (/\btest\b|\bassessment\b/.test(haystack)) return "test";
  if (/\bconferences?\b/.test(haystack)) return "event";
  if (/\bfield trip\b/.test(haystack)) return "field_trip";
  if (/\bno school\b|\bholiday\b/.test(haystack)) return "no_school";
  if (/\bearly dismissal\b/.test(haystack)) return "early_dismissal";
  return "event";
}

/** Only the fields we actually read; the rest of each item is ignored. */
interface CalendarItem {
  _id?: string;
  title?: string;
  description?: string;
  startDate?: string;
  startDateTime?: string;
  allDayEvent?: boolean;
  timezone?: string;
}

interface StoryItem {
  _id?: string;
  time?: string;
  contents?: { body?: string };
}

export interface ParseClassDojoResult {
  events: ExtractedEvent[];
  /** Items withheld for being personal, credential-bearing or not school-related. */
  redactedItems: number;
}

/** Clock time of an ISO instant in a given zone, e.g. "1:50 PM". */
function timeInZone(isoInstant: string, timeZone: string): string | null {
  const instant = new Date(isoInstant);
  if (Number.isNaN(instant.getTime())) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(instant);
  } catch {
    return null;
  }
}

/** Turns `/api/parentCalendarEvent` items into dated events. */
export function parseClassDojoCalendar(
  items: CalendarItem[],
  fallbackTimeZone: string,
  extraNames: string[] = [],
): ParseClassDojoResult {
  const events: ExtractedEvent[] = [];
  const seen = new Set<string>();
  let redactedItems = 0;

  for (const item of items) {
    const zone = item.timezone || fallbackTimeZone;
    // startDate is already the local calendar date; fall back to deriving it.
    const date =
      item.startDate && /^\d{4}-\d{2}-\d{2}$/.test(item.startDate)
        ? item.startDate
        : item.startDateTime
          ? isoDateInTimeZone(item.startDateTime, zone)
          : null;
    if (!date) continue;

    const rawTitle = (item.title ?? "").trim();
    if (!rawTitle) continue;
    if (mustDropLine(rawTitle) || mustDropLine(item.description ?? "")) {
      redactedItems++;
      continue;
    }

    const title = redactPersonalNames(rawTitle, extraNames);
    if (!title) {
      redactedItems++;
      continue;
    }

    const key = `${title.toLowerCase()}|${date}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const category = classifyEvent(`${title} ${item.description ?? ""}`);
    events.push({
      date,
      time: item.allDayEvent || !item.startDateTime ? null : timeInZone(item.startDateTime, zone),
      title,
      category,
      description: redactPersonalNames((item.description ?? "").trim(), extraNames),
      importance: category === "test" || category === "quiz" ? "high" : "medium",
      uncertain: false,
      ...(item.startDateTime ? { received_at: item.startDateTime } : {}),
    });
  }

  events.sort(
    (first, second) =>
      first.date.localeCompare(second.date) || first.title.localeCompare(second.title),
  );
  return { events, redactedItems };
}

/** Turns `/api/storyFeed` items into one announcement per teacher post. */
export function parseClassDojoStoryFeed(
  items: StoryItem[],
  timeZone: string,
  extraNames: string[] = [],
): ParseClassDojoResult {
  const events: ExtractedEvent[] = [];
  const seen = new Set<string>();
  let redactedItems = 0;

  for (const item of items) {
    const body = (item.contents?.body ?? "").trim();
    if (!body || !item.time) continue;

    // Belt and braces: withSyntheticPosts=false should already exclude these.
    if (SYNTHETIC_EVENT_BODY.test(body)) continue;

    const date = isoDateInTimeZone(item.time, timeZone);
    if (!date) continue;

    // Drop whole lines carrying credentials or contact details, then redact names.
    const lines = body.split(/\r?\n/);
    const keptLines = lines.filter((line) => {
      if (line.trim() && mustDropLine(line)) {
        redactedItems++;
        return false;
      }
      return true;
    });
    const text = redactPersonalNames(keptLines.join("\n"), extraNames).trim();
    if (!text) continue;

    if (!looksSchoolRelevant(text)) {
      redactedItems++;
      continue;
    }

    const firstLine = text.split(/\r?\n/).find((line) => line.trim()) ?? text;
    const sentence = firstLine.split(/(?<=[.!?])\s/)[0] ?? firstLine;
    const title = (sentence.length > 90 ? `${sentence.slice(0, 87).trimEnd()}…` : sentence).trim();
    if (!title) continue;

    const key = item._id ?? `${title.toLowerCase()}|${date}`;
    if (seen.has(key)) continue;
    seen.add(key);

    events.push({
      date,
      time: null,
      title,
      category: "announcement",
      description: text,
      importance: "low",
      uncertain: false,
      received_at: item.time,
    });
  }

  events.sort((first, second) =>
    (second.received_at ?? "").localeCompare(first.received_at ?? ""),
  );
  return { events, redactedItems };
}

/** The API path a ClassDojo source's page maps to. */
export function classDojoApiPath(pageUrl: string): string {
  return pageUrl.includes("/story")
    ? "/api/storyFeed?withStudentCommentsAndLikes=false&withSyntheticPosts=false"
    : "/api/parentCalendarEvent?limit=50&hidePastEvents=true";
}

/** Parses a stored API response for a ClassDojo source. */
export function parseClassDojo(
  pageUrl: string,
  rawJson: string,
  timeZone: string,
  extraNames: string[] = [],
): ParseClassDojoResult {
  let payload: { _items?: unknown[] };
  try {
    payload = JSON.parse(rawJson) as { _items?: unknown[] };
  } catch {
    return { events: [], redactedItems: 0 };
  }
  const items = Array.isArray(payload._items) ? payload._items : [];
  return pageUrl.includes("/story")
    ? parseClassDojoStoryFeed(items as StoryItem[], timeZone, extraNames)
    : parseClassDojoCalendar(items as CalendarItem[], timeZone, extraNames);
}
