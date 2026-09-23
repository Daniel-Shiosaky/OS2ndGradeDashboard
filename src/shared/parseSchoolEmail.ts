// Extractor for school email, with a hard rule: only mail that was broadcast to
// the whole school or class is published.
//
// This reads a PERSONAL mailbox, so the filter is the point of the module, not a
// nicety. Anything that looks like a direct message, or like billing, is
// withheld. The gates are independent and a message must clear all of them:
//
//   1. It must carry a positive BROADCAST signal. Restricting by sender is not
//      enough — a teacher who emails all parents also emails one parent.
//   2. It must not look like billing or finance.
//   3. It must not be a one-to-one message.
//   4. Credential and contact lines are dropped, and names redacted, as everywhere.
//   5. It must carry something school-actionable, as with the ClassDojo feed.
//
// Erring toward withholding is deliberate: the dashboard is published to a public
// URL, so a false positive is unrecoverable while a false negative just means an
// item is missing.

import { mustDropLine, redactPersonalNames } from "./redact.js";
import { looksSchoolRelevant } from "./relevance.js";
import { isoDateInTimeZone } from "./weekRange.js";
import { escapeRegExp } from "./text.js";
import type { ExtractedEvent } from "../types/schema.js";

/** Mirrors FetchedEmail in fetchSources.ts; recipients are never included. */
export interface EmailMessage {
  subject: string;
  date: string | null;
  fromDomain: string;
  body: string;
  recipientCount: number;
  hasListHeaders: boolean;
  bulkPrecedence: boolean;
  undisclosedRecipients: boolean;
}

/**
 * Financial mail, split by where the wording appears.
 *
 * A subject line about billing is decisive. Bodies need a narrower list: a
 * perfectly ordinary class newsletter mentions "a $10 field trip fee" or the PTA
 * "fundraiser", and an earlier version rejected the school's own newsletter as
 * billing because of a bare "$" match.
 */
const BILLING_SUBJECT_PATTERNS = [
  /\binvoice\b/i, /\bbilling\b/i, /\bpayment\b/i, /\bbalance\b/i,
  /\bstatement\b/i, /\btuition\b/i, /\breceipt\b/i, /\bamount due\b/i,
  /\bautopay\b/i, /\bpast due\b/i, /\brefund\b/i, /\bsubscription\b/i,
];

const BILLING_BODY_PATTERNS = [
  /\binvoice number\b/i, /\bamount due\b/i, /\bpast due\b/i, /\bautopay\b/i,
  /\bstatement of account\b/i, /\bcredit card\b/i, /\bbilling (?:address|portal|statement)\b/i,
  /\byour balance is\b/i, /\btuition (?:payment|statement|invoice)\b/i,
];

/**
 * Subject wording typical of a message written to one family.
 *
 * Checked against the SUBJECT only. Matching these in the body was useless:
 * "confidential" appears in the standard footer disclaimer on every message the
 * school sends, and "your child's progress" turns up in ordinary newsletter
 * prose. Both rejected every legitimate broadcast.
 */
const DIRECT_SUBJECT_PATTERNS = [
  /\byour (?:child|son|daughter|scholar)'?s?\b/i,
  /\bparent[- ]teacher meeting\b/i,
  /\bconfidential\b/i,
  /\bprogress report\b/i,
  /\breport card\b/i,
  /\bbehaviou?r\b/i,
  /\bmissing (?:work|homework|assignment)/i,
];

/**
 * Where an email's real content stops and its footer begins. Disclaimers and
 * signatures are noise in a published description, and scanning them for
 * meaning produces false positives.
 */
const BOILERPLATE_MARKERS = [
  /^--\s*$/,
  /^_{5,}/,
  /^-{5,}/,
  /this (?:e-?mail|message) and any attachments/i,
  /confidentiality notice/i,
  /^sent from my /i,
  /^you (?:are receiving|received) this (?:e-?mail|message)/i,
  /^to unsubscribe/i,
  /^click here to unsubscribe/i,
];

/** Cuts an email body at the first boilerplate marker. */
export function trimEmailBoilerplate(body: string): string {
  const lines = body.split(/\r?\n/);
  const cut = lines.findIndex((line) => BOILERPLATE_MARKERS.some((pattern) => pattern.test(line.trim())));
  return (cut === -1 ? lines : lines.slice(0, cut)).join("\n").trim();
}

/**
 * Broadcast if any of these hold. Derived from observed mail in a real inbox:
 *
 *   - list headers / Precedence: bulk — a mailing system sent it
 *   - undisclosed-recipients — a blind broadcast
 *   - a known mass-mail sending domain (Blackbaud uses myschoolemails.com and
 *     sets no list headers at all)
 *   - NO visible recipients — the teacher BCC'd the class. This is what
 *     separates "Next Week: 9/21-9/25" (blind copy to every parent) from
 *     "Re: Missing math homework" (addressed to one family)
 *   - three or more addressees — not written to one family
 *
 * Note there is deliberately no "sole recipient is me, therefore direct" rule.
 * Mass-mail systems address each copy individually, so such a rule rejected
 * every genuine school broadcast.
 */
export function isBroadcast(message: EmailMessage, bulkDomains: string[] = []): boolean {
  if (message.hasListHeaders) return true;
  if (message.bulkPrecedence) return true;
  if (message.undisclosedRecipients) return true;
  if (bulkDomains.some((domain) => message.fromDomain.endsWith(domain.toLowerCase()))) return true;
  if (message.recipientCount === 0) return true;
  return message.recipientCount >= 3;
}

export type WithheldReason =
  | "not-broadcast"
  | "billing"
  | "direct-message"
  | "not-school-related"
  | "empty-after-redaction";

export interface ParseEmailResult {
  events: ExtractedEvent[];
  /** Counts by reason, so a run can report what it held back without printing it. */
  withheld: Record<WithheldReason, number>;
}

function emptyWithheld(): Record<WithheldReason, number> {
  return {
    "not-broadcast": 0,
    billing: 0,
    "direct-message": 0,
    "not-school-related": 0,
    "empty-after-redaction": 0,
  };
}

export interface ParseEmailOptions {
  timeZone: string;
  extraNames?: string[];
  /** Sending domains treated as mass-mail systems. */
  bulkDomains?: string[];
  /**
   * Set when the source's sender only ever broadcasts — a school
   * communications or newsletter address, say. Such mail can be indistinguishable
   * from a direct message by its headers alone: the school's "Inside the Spark"
   * newsletter arrives individually addressed from the same domain a teacher
   * uses for private replies. An administrator naming the channel is more
   * reliable than guessing. Senders who send both kinds (a class teacher) must
   * NOT set this and are judged per message.
   */
  broadcastChannel?: boolean;
}

/** Turns fetched mail into announcements, withholding anything not broadcast. */
export function parseSchoolEmail(
  rawJson: string,
  { timeZone, extraNames = [], bulkDomains = [], broadcastChannel = false }: ParseEmailOptions,
): ParseEmailResult {
  const withheld = emptyWithheld();
  let payload: { messages?: EmailMessage[] };
  try {
    payload = JSON.parse(rawJson) as { messages?: EmailMessage[] };
  } catch {
    return { events: [], withheld };
  }

  const events: ExtractedEvent[] = [];
  const seen = new Set<string>();

  for (const message of payload.messages ?? []) {
    if (!message?.date) continue;

    // 1. Broadcast only — unless the whole channel is an announcement channel.
    if (!broadcastChannel && !isBroadcast(message, bulkDomains)) {
      withheld["not-broadcast"]++;
      continue;
    }

    // Footers are neither content nor evidence; drop them before anything else.
    const cleanBody = trimEmailBoilerplate(message.body);
    const haystack = `${message.subject}\n${cleanBody}`;

    // 2b. A configured child's name anywhere means the message is about that
    // child. Withhold the whole thing rather than publish a redacted version:
    // "Childname's Q1 Conference Invite" redacts to "Q1 Conference Invite", which
    // reads like a class-wide notice but was written to one family.
    if (extraNames.some((name) => new RegExp(`\\b${escapeRegExp(name)}\\b`, "i").test(haystack))) {
      withheld["direct-message"]++;
      continue;
    }
    // 3. Never publish anything financial.
    if (
      BILLING_SUBJECT_PATTERNS.some((pattern) => pattern.test(message.subject)) ||
      BILLING_BODY_PATTERNS.some((pattern) => pattern.test(cleanBody))
    ) {
      withheld.billing++;
      continue;
    }
    // 4. Subject-level signs of a one-to-one message.
    if (DIRECT_SUBJECT_PATTERNS.some((pattern) => pattern.test(message.subject))) {
      withheld["direct-message"]++;
      continue;
    }

    // 4. Drop credential/contact lines, then redact names.
    const keptLines = cleanBody
      .split(/\r?\n/)
      .filter((line) => !(line.trim() && mustDropLine(line)));
    const body = redactPersonalNames(keptLines.join("\n"), extraNames).trim();
    const subject = redactPersonalNames(message.subject, extraNames).trim();
    if (!subject && !body) {
      withheld["empty-after-redaction"]++;
      continue;
    }

    // 5. Must be about school business — unless the whole channel is the
    // school's announcement address, where everything is school business by
    // definition. Requiring keywords there wrongly dropped "Extended Care
    // Location Change For Today" and "Chapel Chats".
    if (!broadcastChannel && !looksSchoolRelevant(`${subject}\n${body}`)) {
      withheld["not-school-related"]++;
      continue;
    }

    const date = isoDateInTimeZone(message.date, timeZone);
    if (!date) continue;

    const title = subject || (body.split(/\r?\n/)[0] ?? "").slice(0, 90);
    if (!title) {
      withheld["empty-after-redaction"]++;
      continue;
    }

    const key = `${title.toLowerCase()}|${date}`;
    if (seen.has(key)) continue;
    seen.add(key);

    events.push({
      date,
      time: null,
      title: title.length > 90 ? `${title.slice(0, 87).trimEnd()}…` : title,
      category: "announcement",
      description: body,
      importance: "low",
      uncertain: false,
      received_at: message.date,
    });
  }

  events.sort((first, second) =>
    (second.received_at ?? "").localeCompare(first.received_at ?? ""),
  );
  return { events, withheld };
}

/** Compact "3 not-broadcast, 1 billing" summary for the run log. */
export function summariseWithheld(withheld: Record<WithheldReason, number>): string {
  return Object.entries(withheld)
    .filter(([, n]) => n > 0)
    .map(([reason, n]) => `${n} ${reason}`)
    .join(", ");
}
