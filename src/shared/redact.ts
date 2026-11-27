// Redaction shared by every source parser.
//
// Everything this pipeline extracts is published to a PUBLIC web page, so this
// runs on all text before it can become an event, a description or an outline
// item. It is deliberately mechanical: relying on an AI to honour a "no names"
// instruction every week is a weaker guarantee than deleting the names outright.
//
// What is removed, and what is deliberately kept:
//
//   "courtesy of the Testfamily family"   -> REMOVED, another family's surname
//   "Special thanks to The Othername Family" -> REMOVED, same, different casing
//   "Childname's story"                      -> REMOVED, a child's name (config-driven)
//   "Username: ... / Password: ..."        -> line DROPPED entirely
//   "Mrs. Rivera's Q1 Conferences"         -> KEPT
//
// Staff names are kept on purpose. They are school employees named in their
// professional capacity in a document the school already distributes, and
// removing them destroyed real meaning: the newsletter lists one Q1 conference
// day per teacher, so stripping the names produced two identical "Q1
// Conferences" rows on different dates with no way to tell which was which.
// Names of children and of other families are a different matter and still go.

import type { ExtractedEvent } from "../types/schema.js";
import { escapeRegExp, splitCommaList } from "./text.js";

/** "the Othername Family", "The Thirdname family", "the Testfamily family". */
const FAMILY_NAME = /\b[Tt]he\s+[A-Z][\p{L}'’-]+\s+[Ff]amil(?:y|ies)\b/gu;

/**
 * Extra names to delete, from `REDACT_NAMES` (comma-separated). Needed for bare
 * first names like a child's, which no general pattern can safely detect — a
 * capitalised word is not enough to go on without deleting ordinary words too.
 */
export function namesFromEnv(env: Record<string, string | undefined>): string[] {
  return splitCommaList(env.REDACT_NAMES);
}

/** Strips names of children and other families, leaving staff names in place. */
export function redactPersonalNames(text: string, extraNames: string[] = []): string {
  let redacted = text.replace(FAMILY_NAME, "a family");

  for (const name of extraNames) {
    redacted = redacted.replace(new RegExp(`\\b${escapeRegExp(name)}(?:['’]s)?\\b`, "gi"), "");
  }

  return (
    redacted
      .replace(/\s{2,}/g, " ")
      // A removed name leaves a gap before the punctuation that followed it:
      // "under the direction of Ms. Kevi." -> "under the direction of ."
      .replace(/\s+([.,!?;:])/g, "$1")
      // Punctuation left dangling at the start. Dashes are excluded because the
      // newsletter writes spelling patterns as "–le and -nh".
      .replace(/^[\s:;,]+/, "")
      .trim()
  );
}

/** Credential-shaped content. A newsletter really did publish a password hint. */
const CREDENTIAL_PATTERNS = [
  /\bpassword\b/i,
  /\busername\b/i,
  /\blog\s*in\s*information\b/i,
  /\blogin\s*info/i,
];

/** Direct contact details, which have no place on a public class dashboard. */
const CONTACT_PATTERNS = [
  /[\w.+-]+@[\w-]+\.[\w.]+/,
  // US-style numbers in the shapes people actually write: 555-123-4567,
  // (555) 123-4567, 555.123.4567, +1 555 123 4567 and a bare 5551234567. The
  // old pattern required a separator straight after the area code, so the
  // parenthesised and unseparated forms were published. Over-matching only
  // costs a dropped line; under-matching publishes a phone number.
  /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/,
];

/** True when a line must be dropped entirely rather than redacted in place. */
export function mustDropLine(line: string): boolean {
  return (
    CREDENTIAL_PATTERNS.some((pattern) => pattern.test(line)) ||
    CONTACT_PATTERNS.some((pattern) => pattern.test(line))
  );
}

/** True when `text` mentions any configured child name as a whole word. */
export function mentionsAnyName(text: string, names: string[]): boolean {
  return names.some(
    (name) => name.trim() !== "" && new RegExp(`\\b${escapeRegExp(name.trim())}\\b`, "i").test(text),
  );
}

/**
 * Mechanical clean-up for text that is about to be sent to a third-party model.
 *
 * The deterministic parsers redact as they read, so the AI fallback was the one
 * path where raw text — credential lines, phone numbers, a child's name — went
 * out and came back unfiltered, relying on the prompt alone. A line that names a
 * configured child is dropped rather than trimmed, matching the email lane:
 * "Childname is student of the week" stays identifying after the name is cut.
 */
export function redactSourceText(
  text: string,
  names: string[] = [],
): { text: string; droppedLines: number } {
  let droppedLines = 0;
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() && (mustDropLine(line) || mentionsAnyName(line, names))) {
      droppedLines++;
      continue;
    }
    kept.push(redactPersonalNames(line, names));
  }
  return { text: kept.join("\n"), droppedLines };
}

/**
 * Applies the same rules to what the model returned, since a model can echo or
 * reconstruct what the input filter removed. An event whose title or description
 * would be dropped or names a child is discarded whole; anything else is redacted.
 */
export function sanitizeExtractedEvents(
  events: ExtractedEvent[],
  names: string[] = [],
): { events: ExtractedEvent[]; withheld: number } {
  const clean: ExtractedEvent[] = [];
  let withheld = 0;
  for (const event of events) {
    const combined = `${event.title}\n${event.description}`;
    if (mustDropLine(event.title) || mustDropLine(event.description) || mentionsAnyName(combined, names)) {
      withheld++;
      continue;
    }
    const title = redactPersonalNames(event.title, names);
    if (!title) {
      withheld++;
      continue;
    }
    clean.push({ ...event, title, description: redactPersonalNames(event.description, names) });
  }
  return { events: clean, withheld };
}
