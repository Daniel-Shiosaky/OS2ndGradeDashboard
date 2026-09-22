// Step: send fetched source text to the configured AI provider and extract
// structured events. The prompt enforces the project's core rule: organize,
// never invent. See section 14 of the project brief.

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getAiProvider } from "./aiProvider.js";
import { isMainModule } from "./runGuard.js";
import {
  ExtractionResultSchema,
  type ExtractedEvent,
  type SourceConfigEntry,
} from "../types/schema.js";
import type { FetchedSource } from "./fetchSources.js";

const RAW_DIR = path.resolve(import.meta.dirname, "../../output/raw");
const PENDING_PATH = path.resolve(import.meta.dirname, "../../data/pending-review.json");

const SYSTEM_PROMPT = `You are extracting factual information from school sources.

Do not invent information.
Only report information supported by the supplied source text.
Preserve exact dates when available.
If a date is ambiguous, do not guess — omit the event instead.
Every event must be grounded in the supplied text.
Return valid JSON matching the supplied schema.
Do not include conversational commentary outside the JSON.`;

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
    text.slice(0, 20_000),
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
}

export async function extractFromSource(
  fetched: FetchedSource,
  today = new Date().toISOString().slice(0, 10),
): Promise<SourceExtraction> {
  const provider = getAiProvider();
  const userPrompt = buildUserPrompt(fetched.source, fetched.text, today);
  const raw = await provider.complete({ systemPrompt: SYSTEM_PROMPT, userPrompt });

  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch {
    throw new Error(`AI response for "${fetched.source.name}" was not valid JSON`);
  }

  const result = ExtractionResultSchema.parse(parsed);
  return { source: fetched.source, events: result.events };
}

export async function processAllFetched(): Promise<SourceExtraction[]> {
  let files: string[] = [];
  try {
    files = (await readdir(RAW_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    files = [];
  }

  if (files.length === 0) {
    console.log("No fetched source content found; nothing to process.");
    return [];
  }

  console.log("Processing source content...");
  const results: SourceExtraction[] = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(path.join(RAW_DIR, file), "utf-8")) as FetchedSource;
    try {
      const extraction = await extractFromSource(raw);
      console.log(`  OK   AI extraction (${raw.source.name}): ${extraction.events.length} event(s)`);
      results.push(extraction);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL AI extraction (${raw.source.name}): ${message}`);
    }
  }
  return results;
}

async function main() {
  const results = await processAllFetched();
  const totalEvents = results.reduce((sum, r) => sum + r.events.length, 0);

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
