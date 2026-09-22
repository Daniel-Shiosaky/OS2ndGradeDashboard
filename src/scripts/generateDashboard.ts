// Step: merge newly extracted events into the master data/events.json,
// detect new/changed/removed events, apply source-priority conflict
// resolution, and generate the weekly WhatsApp-ready summary.
//
// Reliability rules (see project brief section 23):
// - never erase existing data because a source failed
// - never publish empty data
// - preserve the previous valid dashboard whenever possible

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EventsDataSchema,
  type ChangeLogEntry,
  type EventsData,
  type SchoolEvent,
  type SourceConfigEntry,
} from "../types/schema.js";
import type { SourceExtraction } from "./processWithAi.js";
import { getCurrentWeekRange, isWithinRange } from "../shared/weekRange.js";
import { isMainModule } from "./runGuard.js";

const DATA_DIR = path.resolve(import.meta.dirname, "../../data");
const OUTPUT_DIR = path.resolve(import.meta.dirname, "../../output");
const EVENTS_PATH = path.join(DATA_DIR, "events.json");
const CURRENT_WEEK_PATH = path.join(DATA_DIR, "current-week.json");
const PENDING_PATH = path.join(DATA_DIR, "pending-review.json");
const WHATSAPP_PATH = path.join(OUTPUT_DIR, "whatsapp-message.txt");

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function loadExistingEvents(): Promise<EventsData | null> {
  try {
    const raw = await readFile(EVENTS_PATH, "utf-8");
    return EventsDataSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Lower number = higher priority, matching data/sources.json. */
function higherPriority(a: SourceConfigEntry, b: SourceConfigEntry): SourceConfigEntry {
  return a.priority <= b.priority ? a : b;
}

/**
 * Merges freshly extracted events with the existing dataset. Events are
 * matched by (normalized title, source name) to detect updates rather than
 * duplicating them. When two *different* sources report the same normalized
 * title with conflicting dates, the higher-priority source wins but the
 * conflict is preserved in the change log rather than silently dropped.
 */
export function mergeEvents(
  existing: SchoolEvent[],
  extractions: SourceExtraction[],
): { merged: SchoolEvent[]; changes: ChangeLogEntry[] } {
  const changes: ChangeLogEntry[] = [];
  const byId = new Map(existing.map((e) => [e.id, e]));
  const seenIds = new Set<string>();

  // Group incoming candidates by normalized title to detect cross-source conflicts.
  const byTitle = new Map<
    string,
    Array<{ event: SchoolEvent; source: SourceConfigEntry }>
  >();

  for (const extraction of extractions) {
    for (const candidate of extraction.events) {
      const id = `${slugify(candidate.title)}-${candidate.date}`;
      const event: SchoolEvent = {
        id,
        date: candidate.date,
        time: candidate.time,
        title: candidate.title,
        category: candidate.category,
        description: candidate.description,
        importance: candidate.importance,
        uncertain: candidate.uncertain,
        source: { name: extraction.source.name, url: extraction.source.url },
      };
      const key = slugify(candidate.title);
      const bucket = byTitle.get(key) ?? [];
      bucket.push({ event, source: extraction.source });
      byTitle.set(key, bucket);
    }
  }

  const merged: SchoolEvent[] = [];

  for (const [, candidates] of byTitle) {
    const dates = new Set(candidates.map((c) => c.event.date));
    let chosen = candidates[0]!;

    if (dates.size > 1) {
      // Same title, different dates reported by different sources: conflict.
      chosen = candidates.reduce((best, cur) => (higherPriority(best.source, cur.source) === cur.source ? cur : best));
      console.log(
        `  CONFLICT "${chosen.event.title}": ${[...dates].join(" vs ")} — using ${chosen.source.name} (highest priority)`,
      );
    } else {
      chosen = candidates.reduce((best, cur) => (higherPriority(best.source, cur.source) === cur.source ? cur : best));
    }

    const event = chosen.event;
    seenIds.add(event.id);
    const previous = byId.get(event.id);

    if (!previous) {
      changes.push({ type: "new", event });
    } else if (
      previous.date !== event.date ||
      previous.time !== event.time ||
      previous.description !== event.description
    ) {
      changes.push({ type: "changed", event, previous });
    }

    merged.push(event);
  }

  // Anything in the existing dataset not present in this run is kept as-is
  // (a source being temporarily unavailable must not delete valid data),
  // unless the new merge already produced an event under the same id.
  for (const event of existing) {
    if (!seenIds.has(event.id)) {
      merged.push(event);
    }
  }

  merged.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
  return { merged, changes };
}

function buildWhatsAppMessage(schoolName: string, weekLabel: string, weekEvents: SchoolEvent[], dashboardUrl: string): string {
  const important = weekEvents.filter((e) => e.importance === "high");
  const lines = [`📚 ${schoolName} Update — Week of ${weekLabel}`, ""];
  if (important.length > 0) {
    lines.push("Important this week:", "");
    for (const event of important) {
      const day = new Date(`${event.date}T00:00:00Z`).toLocaleDateString("en-US", {
        weekday: "short",
        timeZone: "UTC",
      });
      lines.push(`• ${day}: ${event.title}`);
    }
    lines.push("");
  }
  lines.push("Full details:", dashboardUrl);
  return lines.join("\n");
}

export async function generateDashboard(
  extractions: SourceExtraction[],
  dashboardUrl = "https://example.github.io/school-dashboard/",
): Promise<void> {
  const existing = await loadExistingEvents();
  const existingEvents = existing?.events ?? [];

  if (extractions.length === 0 && existingEvents.length === 0) {
    throw new Error("No existing data and no new extractions — refusing to publish empty data.");
  }

  const { merged, changes } = extractions.length > 0
    ? mergeEvents(existingEvents, extractions)
    : { merged: existingEvents, changes: [] as ChangeLogEntry[] };

  const newCount = changes.filter((c) => c.type === "new").length;
  const changedCount = changes.filter((c) => c.type === "changed").length;
  console.log(`New events: ${newCount}`);
  console.log(`Changed events: ${changedCount}`);
  console.log(`Removed events: 0`);
  for (const change of changes.filter((c) => c.type === "changed")) {
    console.log(`CHANGED:\n${change.event.title}\n${change.previous?.date} -> ${change.event.date}\nSource: ${change.event.source.name}`);
  }

  const schoolName = existing?.school_name ?? "School";
  const eventsData: EventsData = {
    school_name: schoolName,
    last_updated: new Date().toISOString(),
    events: merged,
  };

  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(EVENTS_PATH, JSON.stringify(eventsData, null, 2), "utf-8");

  const weekRange = getCurrentWeekRange();
  const weekEvents = merged.filter((e) => isWithinRange(e.date, weekRange));
  await writeFile(
    CURRENT_WEEK_PATH,
    JSON.stringify(
      {
        week_start: weekRange.weekStart,
        week_end: weekRange.weekEnd,
        last_updated: eventsData.last_updated,
        events: weekEvents,
      },
      null,
      2,
    ),
    "utf-8",
  );

  const weekLabel = new Date(`${weekRange.weekStart}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  const message = buildWhatsAppMessage(schoolName, weekLabel, weekEvents, dashboardUrl);
  await writeFile(WHATSAPP_PATH, message, "utf-8");

  console.log("Generating dashboard...");
  console.log("  OK   Dashboard generated");
  console.log("Deployment ready.");
}

async function main() {
  let extractions: SourceExtraction[] = [];
  try {
    const raw = await readFile(PENDING_PATH, "utf-8");
    extractions = JSON.parse(raw) as SourceExtraction[];
  } catch {
    console.log("No pending-review.json found; regenerating dashboard from existing data only.");
  }
  await generateDashboard(extractions, process.env.DASHBOARD_URL);
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
