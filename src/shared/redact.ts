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
  /\b\d{3}[.\-\s]\d{3}[.\-\s]\d{4}\b/,
];

/** True when a line must be dropped entirely rather than redacted in place. */
export function mustDropLine(line: string): boolean {
  return (
    CREDENTIAL_PATTERNS.some((pattern) => pattern.test(line)) ||
    CONTACT_PATTERNS.some((pattern) => pattern.test(line))
  );
}
