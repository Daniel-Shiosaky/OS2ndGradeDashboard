// Step: send fetched source text to the configured AI provider and extract
// structured events. The prompt enforces the project's core rule: organize,
// never invent. See section 14 of the project brief.

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getAiProvider } from "./aiProvider.js";
import { parseNewsletter } from "../shared/parseNewsletter.js";
import { parseClassDojo } from "../shared/parseClassDojo.js";
import { parseSchoolEmail, summariseWithheld } from "../shared/parseSchoolEmail.js";
import { namesFromEnv, redactSourceText, sanitizeExtractedEvents } from "../shared/redact.js";
import { splitCommaList } from "../shared/text.js";
import { todayInTimeZone } from "../shared/weekRange.js";
import { isMainModule } from "./runGuard.js";
import {
  ExtractionResultSchema,
  SourcesConfigSchema,
  type ExtractedEvent,
  type NewsletterDigest,
  type SourceConfigEntry,
} from "../types/schema.js";
import type { FetchedSource } from "./fetchSources.js";

const RAW_DIR = path.resolve(import.meta.dirname, "../../output/raw");
const PENDING_PATH = path.resolve(import.meta.dirname, "../../data/pending-review.json");
const SOURCES_PATH = path.resolve(import.meta.dirname, "../../data/sources.json");

/** School timezone from the admin-editable config, defaulting to UTC. */
async function loadConfiguredTimeZone(): Promise<string> {
  try {
    const raw = await readFile(SOURCES_PATH, "utf-8");
    return SourcesConfigSchema.parse(JSON.parse(raw)).timezone;
  } catch {
    return "UTC";
  }
}

/** Enabled sources from the admin config, or null when it cannot be read. */
async function loadEnabledSources(): Promise<SourceConfigEntry[] | null> {
  try {
    const raw = await readFile(SOURCES_PATH, "utf-8");
    return SourcesConfigSchema.parse(JSON.parse(raw)).sources.filter((source) => source.enabled);
  } catch {
    return null;
  }
}

/**
 * Which raw files belong in this run.
 *
 * output/raw/ is a cache that only ever grows: a source removed from the config
 * leaves its file behind, and the newsletter writes a new file every week
 * (its source name carries the week, "Name (11/30-12/4)"). Processing every file
 * meant removed placeholder sources were sent to the AI and last September's
 * newsletter kept republishing its events alongside this week's.
 *
 * A file is kept only if it belongs to a currently enabled source, and when
 * several files belong to the same source (the weekly newsletters) only the most
 * recently fetched one is kept.
 */
export function selectCurrentRawFiles<T extends { source: { name: string }; fetchedAt: string }>(
  entries: { fileName: string; fetched: T }[],
  enabledSources: SourceConfigEntry[],
): { current: { fileName: string; fetched: T }[]; skipped: { fileName: string; reason: string }[] } {
  const newestPerSource = new Map<string, { fileName: string; fetched: T }>();
  const skipped: { fileName: string; reason: string }[] = [];

  for (const entry of entries) {
    const owner = enabledSources.find(
      (source) =>
        entry.fetched.source.name === source.name ||
        entry.fetched.source.name.startsWith(`${source.name} (`),
    );
    if (!owner) {
      skipped.push({ fileName: entry.fileName, reason: "not an enabled source in data/sources.json" });
      continue;
    }
    const previous = newestPerSource.get(owner.name);
    if (!previous) {
      newestPerSource.set(owner.name, entry);
    } else if (entry.fetched.fetchedAt > previous.fetched.fetchedAt) {
      skipped.push({ fileName: previous.fileName, reason: `superseded by a newer fetch of ${owner.name}` });
      newestPerSource.set(owner.name, entry);
    } else {
      skipped.push({ fileName: entry.fileName, reason: `superseded by a newer fetch of ${owner.name}` });
    }
  }

  return { current: [...newestPerSource.values()], skipped };
}

// The extracted output is published to a PUBLIC dashboard, so the prompt carries
// privacy rules alongside the accuracy rules. These are not hypothetical: a real
// newsletter contained a student login pattern ("Username:
// firstname.lastname@scholars...  Password: Scholar's birthdate"), which must
// never be republished.
const SYSTEM_PROMPT = `You are extracting factual information from school sources.

ACCURACY
Do not invent information.
Only report information supported by the supplied source text.
Preserve exact dates when available.
If a date is ambiguous, do not guess — omit the event instead.
Every event must be grounded in the supplied text.

PRIVACY — the output is published on a public web page.
Extract only class-wide or school-wide information.
Never include the name of any student, child, parent or family.
Never include credentials, usernames, passwords, login instructions, or
password hints of any kind, even when the source text contains them.
Never include phone numbers, email addresses, home addresses, ID numbers,
or individual appointment slots assigned to a named person.
Describe staff-led items by role or subject rather than by personal name
(for example "Q1 second grade conferences", not a teacher's name).
If an item cannot be described without personal information, omit it.

OUTPUT
Return valid JSON matching the supplied schema.
Do not include conversational commentary outside the JSON.`;

// Upper bound on source text sent to the model, in characters. The old 20k cap
// silently dropped the newest 4 of 11 teacher emails on a real inbox — i.e. the
// most relevant ones. 100k chars is ~25k tokens, comfortably inside every
// provider configured here, and fetchSources now orders mail newest-first so a
// cap that does bite drops the stalest content.
const DEFAULT_MAX_SOURCE_CHARS = 100_000;

function maxSourceChars(): number {
  const raw = process.env.AI_MAX_SOURCE_CHARS;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_SOURCE_CHARS;
}

/** Caps source text, reporting the loss instead of truncating silently. */
export function capSourceText(
  text: string,
  limit: number,
  sourceName: string,
  log: (message: string) => void = console.log,
): string {
  if (text.length <= limit) return text;
  log(
    `  WARN ${sourceName}: source text is ${text.length} chars, capping at ${limit}; ` +
      `${text.length - limit} chars not sent to the model`,
  );
  return text.slice(0, limit);
}

function buildUserPrompt(source: SourceConfigEntry, text: string, today: string): string {
  return [
    `Today's date is ${today}.`,
    `Source name: ${source.name}`,
    `Source type: ${source.type}`,
    "",
    "Extract school events (homework, tests, quizzes, projects, events, field trips,",
    "deadlines, supplies to bring, announcements, holidays, no-school days, early",
    "dismissal days) from the text below.",
    "",
    "Respond with ONLY JSON matching this shape (no markdown fences):",
    `{"events": [{"date": "YYYY-MM-DD", "time": "HH:MM" | null, "title": string,`,
    `"category": "homework"|"test"|"quiz"|"project"|"event"|"field_trip"|"deadline"|`,
    `"supplies"|"announcement"|"holiday"|"no_school"|"early_dismissal"|"other",`,
    `"description": string, "importance": "high"|"medium"|"low", "uncertain": boolean}],`,
    `"conflicts": [{"description": string}]}`,
    "",
    "Source text:",
    "---",
    capSourceText(text, maxSourceChars(), source.name),
    "---",
  ].join("\n");
}

export function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : trimmed;
  return JSON.parse(candidate ?? "{}");
}

export interface SourceExtraction {
  source: SourceConfigEntry;
  events: ExtractedEvent[];
  /** Present only for template-parsed newsletters; drives the Newsletter panel. */
  newsletter?: NewsletterDigest;
}

/**
 * Source types whose text follows a known template and can be read
 * deterministically. Trying the parser first means the normal weekly run needs
 * no model at all: no rate limit to hit, no cost, reproducible output, and no
 * chance of a date being invented. The AI stays as the fallback for when the
 * school changes the template, which the parser reports by finding nothing.
 */
const DETERMINISTIC_TYPES = new Set(["newsletter_board", "google_doc", "classdojo"]);

export async function extractFromSource(
  fetched: FetchedSource,
  timeZone = "UTC",
  today = todayInTimeZone(timeZone),
): Promise<SourceExtraction> {
  const asOf = new Date(`${today}T12:00:00Z`);

  // ClassDojo has its own two page shapes, handled separately from the newsletter.
  if (fetched.source.type === "classdojo") {
    const names = namesFromEnv(process.env);
    // The API returns UTC instants; the school's zone decides the calendar date.
    const { events, redactedItems } = parseClassDojo(
      fetched.source.url ?? "",
      fetched.text,
      timeZone,
      names,
    );
    if (redactedItems > 0) {
      console.log(`  ..   ${fetched.source.name}: withheld ${redactedItems} item(s) (personal or not school-related)`);
    }
    console.log(`  OK   parsed ${fetched.source.name}: ${events.length} item(s) (no AI needed)`);
    return { source: fetched.source, events };
  }

  // School email is filtered to broadcasts only; see parseSchoolEmail.
  if (fetched.source.type === "gmail") {
    // A missing REDACT_NAMES disables the "message names the child" gate without
    // any other symptom, so say so rather than quietly publishing more.
    if (namesFromEnv(process.env).length === 0) {
      console.log("  WARN REDACT_NAMES is not set — child-name filtering is disabled for email");
    }
    const { events, withheld } = parseSchoolEmail(fetched.text, {
      timeZone,
      extraNames: namesFromEnv(process.env),
      bulkDomains: splitCommaList(process.env.MAIL_BULK_DOMAINS),
      broadcastChannel: fetched.source.broadcastChannel,
    });
    const summary = summariseWithheld(withheld);
    if (summary) console.log(`  ..   ${fetched.source.name}: withheld ${summary}`);
    console.log(`  OK   parsed ${fetched.source.name}: ${events.length} item(s) (no AI needed)`);
    return { source: fetched.source, events };
  }

  if (DETERMINISTIC_TYPES.has(fetched.source.type)) {
    const childNames = namesFromEnv(process.env);
    if (childNames.length === 0) {
      console.log("  WARN REDACT_NAMES is not set — child-name filtering is disabled for the newsletter");
    }
    const { events, sections, redactedLines, namedLines } = parseNewsletter(fetched.text, asOf, childNames);
    if (namedLines > 0) {
      console.log(`  ..   ${fetched.source.name}: withheld ${namedLines} line(s) naming a child`);
    }
    if (redactedLines > 0) {
      console.log(`  ..   ${fetched.source.name}: dropped ${redactedLines} line(s) containing credentials or contact details`);
    }
    if (events.length > 0) {
      console.log(
        `  OK   parsed ${fetched.source.name}: ${events.length} event(s), ${sections.length} section(s) (no AI needed)`,
      );
      return {
        source: fetched.source,
        events,
        newsletter: {
          // First non-empty line of the doc is its own title banner.
          title: fetched.text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? fetched.source.name,
          week_label: fetched.source.name.match(/\(([^)]+)\)/)?.[1] ?? "",
          source: { name: fetched.source.name, url: fetched.source.url, lane: "newsletter" },
          // The outline is not published: the frontend never renders it, and it
          // carries undated lines (notes, verses) that add to what is public for
          // no benefit. The dated items reach the dashboard as events.
          sections: [],
        },
      };
    }
    console.log(
      `  ..   ${fetched.source.name}: template did not match, falling back to AI extraction`,
    );
  }

  // This is the one path where text leaves the process and comes back, so it is
  // filtered on both sides mechanically instead of trusting the prompt alone.
  const childNames = namesFromEnv(process.env);
  const { text: safeText, droppedLines } = redactSourceText(fetched.text, childNames);
  if (droppedLines > 0) {
    console.log(`  ..   ${fetched.source.name}: ${droppedLines} line(s) withheld from the AI (credentials, contact details or a child's name)`);
  }

  const provider = getAiProvider();
  const userPrompt = buildUserPrompt(fetched.source, safeText, today);
  const raw = await provider.complete({ systemPrompt: SYSTEM_PROMPT, userPrompt });

  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch {
    throw new Error(`AI response for "${fetched.source.name}" was not valid JSON`);
  }

  const result = ExtractionResultSchema.parse(parsed);
  const { events: safeEvents, withheld: withheldEvents } = sanitizeExtractedEvents(result.events, childNames);
  if (withheldEvents > 0) {
    console.log(`  ..   ${fetched.source.name}: withheld ${withheldEvents} AI event(s) (credentials, contact details or a child's name)`);
  }
  return { source: fetched.source, events: safeEvents };
}

export async function processAllFetched(): Promise<SourceExtraction[]> {
  let files: string[] = [];
  try {
    files = (await readdir(RAW_DIR)).filter((fileName) => fileName.endsWith(".json"));
  } catch {
    files = [];
  }

  if (files.length === 0) {
    console.log("No fetched source content found; nothing to process.");
    return [];
  }

  // ClassDojo's API returns UTC instants, so the school's zone decides which
  // calendar day an item belongs to.
  const timeZone = await loadConfiguredTimeZone();
  // Derived in the school's zone, not UTC: after 8pm on the US east coast a
  // UTC-derived "today" is already tomorrow, which shifts the year the newsletter
  // parser resolves its bare M/D dates against.
  const today = todayInTimeZone(timeZone);

  const entries: { fileName: string; fetched: FetchedSource }[] = [];
  for (const fileName of files) {
    try {
      const fetched = JSON.parse(await readFile(path.join(RAW_DIR, fileName), "utf-8")) as FetchedSource;
      entries.push({ fileName, fetched });
    } catch {
      console.log(`  SKIP ${fileName}: unreadable raw file`);
    }
  }

  // If the config can't be read, fall back to processing everything rather than
  // publishing nothing.
  const enabledSources = await loadEnabledSources();
  let selected = entries;
  if (enabledSources) {
    const { current, skipped } = selectCurrentRawFiles(entries, enabledSources);
    for (const { fileName, reason } of skipped) console.log(`  SKIP ${fileName}: ${reason}`);
    selected = current;
  }

  const results: SourceExtraction[] = [];
  for (const { fetched: raw } of selected) {
    try {
      // extractFromSource logs which path produced the events (parser or AI),
      // so don't add a second line here claiming a path that may not have run.
      results.push(await extractFromSource(raw, timeZone, today));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL extraction (${raw.source.name}): ${message}`);
    }
  }
  return results;
}

async function main() {
  // The orchestrator prints this header when running the full pipeline; print it
  // here too so the standalone `npm run process-ai` output still reads properly.
  console.log("Processing source content...");
  const results = await processAllFetched();
  const totalEvents = results.reduce((total, extraction) => total + extraction.events.length, 0);

  if (results.length === 0) {
    console.error("AI processing produced no results. Not publishing empty data.");
    process.exitCode = 1;
    return;
  }

  await mkdir(path.dirname(PENDING_PATH), { recursive: true });
  await writeFile(PENDING_PATH, JSON.stringify(results, null, 2), "utf-8");
  console.log(`Events found: ${totalEvents}`);
  console.log(`Wrote ${PENDING_PATH}`);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
