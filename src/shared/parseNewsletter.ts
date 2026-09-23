// Deterministic extractor for the weekly grade newsletter.
//
// The newsletter is a fixed template: subject sections under "Classwork", then a
// "HOMEWORK" block broken down by weekday, with every dated item written as
// "<thing> on <Weekday>, <M/D>" or "<thing> Due <Weekday>, <M/D>". That regularity
// means the events can be read out directly, with no model in the loop.
//
// Preferring this over the AI is deliberate:
//   - it costs nothing and has no rate limit, so a weekly run cannot be blocked
//   - it is reproducible, so the same newsletter always yields the same events
//   - it cannot invent a date that is not in the source
//   - redaction is mechanical rather than a request a model may or may not honour
//
// It is intentionally strict. When the school changes the template it returns
// nothing rather than guessing, and the caller falls back to the AI path.

import { resolveMonthDay } from "./newsletter.js";
import { mustDropLine, redactPersonalNames } from "./redact.js";

import type { Category, ExtractedEvent, Importance } from "../types/schema.js";

/** Re-exported for convenience; the rules live in redact.ts. */
export function redactNames(text: string, extraNames: string[] = []): string {
  return redactPersonalNames(text, extraNames);
}


const WEEKDAY = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday";

/** "on Friday, 9/25", "Due Friday 9/25", ": Tuesday 9/22" — the date phrase. */
const DATE_PHRASE = new RegExp(`(?:\\b(?:${WEEKDAY}))\\b,?\\s*(\\d{1,2})\\/(\\d{1,2})`, "i");

/** Subject headings that appear on their own line under "Classwork". */
const SUBJECTS = ["ELA", "Math", "Social Studies", "Science", "Bible", "Other"];

/** Lines that are structural, not content. */
const STRUCTURAL = new Set(
  ["classwork", "homework", "other", ...WEEKDAY.split("|")].map((heading) => heading.toLowerCase()),
);

function classify(title: string, section: string): Category {
  const haystack = `${section} ${title}`.toLowerCase();
  // Order matters: "Ch. 3 Quiz" sits in the Math section but is a quiz, not homework.
  if (/\bquiz\b/.test(haystack)) return "quiz";
  if (/\btest\b|\bexam\b|\bassessment\b/.test(haystack)) return "test";
  if (/\bpresentation\b|\bproject\b/.test(haystack)) return "project";
  if (/\bfield trip\b/.test(haystack)) return "field_trip";
  if (/\bno school\b|\bholiday\b/.test(haystack)) return "no_school";
  if (/\bearly dismissal\b/.test(haystack)) return "early_dismissal";
  if (/\bbring\b|\bsupplies\b|\bwear\b/.test(haystack)) return "supplies";
  if (/\bconferences?\b/.test(haystack)) return "event";
  if (/\bdue\b|\bhomework\b|\bworkbook\b|\bpg\.|\bpages?\b/.test(haystack)) return "homework";
  if (/\bchallenge\b|\bshowcase\b|\bopen mic\b/.test(haystack)) return "event";
  return "other";
}

function importanceOf(category: Category): Importance {
  if (category === "test" || category === "quiz" || category === "project") return "high";
  if (category === "other") return "low";
  return "medium";
}

/** Strips the trailing date phrase, leaving the description of the item. */
function titleFrom(line: string): string {
  return line
    .replace(new RegExp(`\\bon\\s+(?:${WEEKDAY})\\b,?\\s*\\d{1,2}\\/\\d{1,2}`, "i"), "")
    .replace(new RegExp(`\\b(?:${WEEKDAY})\\b,?\\s*\\d{1,2}\\/\\d{1,2}`, "i"), "")
    .replace(/[\s:;,–—-]+$/, "")
    .trim();
}

function cleanLine(raw: string): string {
  // Strips bullet glyphs only. A leading hyphen is left alone because the
  // newsletter uses it for spelling patterns like "-le and -nh".
  return raw.replace(/^[\s\t*•·]+/, "").replace(/\s+/g, " ").trim();
}

/** One sub-section of the newsletter, e.g. "Classwork — Math" or "Homework — Monday". */
export interface NewsletterSection {
  heading: string;
  items: string[];
}

export interface ParseNewsletterResult {
  events: ExtractedEvent[];
  /**
   * The newsletter's own structure, so the dashboard can show the whole thing
   * grouped as the teachers wrote it, not only the items that carried a date.
   */
  sections: NewsletterSection[];
  /** Lines dropped for containing credentials or contact details. */
  redactedLines: number;
}

/** Block headings that group the sub-sections beneath them. */
const BLOCKS = ["Classwork", "Homework"];
const WEEKDAYS = WEEKDAY.split("|");

/**
 * Reads events out of newsletter plain text. `today` anchors the bare `M/D`
 * dates to a year. Returns an empty list when the template no longer matches,
 * which is the caller's signal to fall back to the AI extractor.
 */
export function parseNewsletter(text: string, today: Date): ParseNewsletterResult {
  const events: ExtractedEvent[] = [];
  const seen = new Set<string>();
  let section = "";
  let redactedLines = 0;

  // Sub-sections keyed by "<block> — <heading>" so the "Other" that appears under
  // both Classwork and Homework doesn't get merged into one bucket.
  const sections = new Map<string, string[]>();
  let block = "";
  let sectionKey = "";
  /**
   * Adds an outline item, rejoining wrapped text. The Google Doc export hard-wraps
   * long sentences, so "Trust in the Lord ... your own" / "understanding; ..." /
   * "make your paths straight." arrive as three lines. A line is treated as a
   * continuation when it carries no bullet marker and the previous item did not
   * end on sentence-ending punctuation.
   */
  const pushItem = (item: string, isBullet: boolean) => {
    if (!sectionKey) return;
    const bucket = sections.get(sectionKey);
    if (!bucket) return;
    const last = bucket[bucket.length - 1];
    // Starting lowercase is the tell. A capitalised unbulleted line is a new
    // topic ("Bible Verse: ...", "Hispanic Heritage Showcase"), not a wrap.
    const looksLikeWrap = /^[a-z]/.test(item);
    if (!isBullet && looksLikeWrap && last !== undefined && !/[.!?:]$/.test(last)) {
      bucket[bucket.length - 1] = `${last} ${item}`.replace(/\s{2,}/g, " ").trim();
      return;
    }
    if (!bucket.includes(item)) bucket.push(item);
  };
  const openSection = (heading: string) => {
    sectionKey = block ? `${block} — ${heading}` : heading;
    if (!sections.has(sectionKey)) sections.set(sectionKey, []);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const isBullet = /^[\s\t]*[*•·]/.test(rawLine);
    const line = cleanLine(rawLine);
    if (!line) continue;

    // Track the current section heading so items can be labelled by subject.
    const subject = SUBJECTS.find((subject) => line.toLowerCase() === subject.toLowerCase());
    if (subject) {
      section = subject;
      openSection(subject);
      continue;
    }
    const weekdayHeading = WEEKDAYS.find((weekday) => line.toLowerCase() === weekday.toLowerCase());
    if (weekdayHeading && block === "Homework") {
      openSection(weekdayHeading);
      continue;
    }
    const blockHeading = BLOCKS.find((block) => line.toLowerCase() === block.toLowerCase());
    if (blockHeading) {
      block = blockHeading;
      section = blockHeading === "Homework" ? "Homework" : "";
      sectionKey = "";
      continue;
    }
    if (STRUCTURAL.has(line.toLowerCase())) continue;

    // Checked before the date filter on purpose: a credential line must be
    // counted and discarded whether or not it happens to carry a date, so the
    // count is a real safety signal rather than an artefact of line ordering.
    if (mustDropLine(line)) {
      redactedLines++;
      continue;
    }

    // Every surviving content line belongs to the newsletter outline, dated or
    // not — that is what makes the expandable Newsletter view complete.
    const outlineItem = redactNames(line);
    if (outlineItem) pushItem(outlineItem, isBullet);

    const match = line.match(DATE_PHRASE);
    if (!match) continue;

    const date = resolveMonthDay(Number(match[1]), Number(match[2]), today);
    if (!date) continue;

    let title = redactNames(titleFrom(line));
    if (!title) continue;

    // Prefix the subject when it adds context: "Ch. 3 Quiz" -> "Math — Ch. 3 Quiz".
    const isSubject = SUBJECTS.includes(section) && section !== "Other";
    if (isSubject && !title.toLowerCase().includes(section.toLowerCase())) {
      title = `${section} — ${title}`;
    }

    const category = classify(title, section);
    const key = `${title.toLowerCase()}|${date}`;
    if (seen.has(key)) continue;
    seen.add(key);

    events.push({
      date,
      time: null,
      title,
      category,
      // Only a subject adds useful context. Labelling a quiz "Homework" just
      // because it was listed under the HOMEWORK block would be misleading.
      description: isSubject ? section : "",
      importance: importanceOf(category),
      uncertain: false,
    });
  }

  events.sort(
    (first, second) =>
      first.date.localeCompare(second.date) || first.title.localeCompare(second.title),
  );

  // Empty sub-sections are dropped: the template ships Tuesday–Friday homework
  // headings every week whether or not anything was assigned.
  const outline: NewsletterSection[] = [...sections.entries()]
    .filter(([, items]) => items.length > 0)
    .map(([heading, items]) => ({ heading, items }));

  return { events, sections: outline, redactedLines };
}
