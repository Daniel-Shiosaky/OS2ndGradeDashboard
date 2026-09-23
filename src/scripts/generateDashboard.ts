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
  SourcesConfigSchema,
  type ChangeLogEntry,
  type EventsData,
  type Lane,
  type SchoolEvent,
  type SectionRule,
  type SourceConfigEntry,
} from "../types/schema.js";
import type { SourceExtraction } from "./processWithAi.js";
import { getCurrentWeekRange, isWithinRange } from "../shared/weekRange.js";
import { slugify } from "../shared/text.js";
import { isMainModule } from "./runGuard.js";

const DATA_DIR = path.resolve(import.meta.dirname, "../../data");
const OUTPUT_DIR = path.resolve(import.meta.dirname, "../../output");
const EVENTS_PATH = path.join(DATA_DIR, "events.json");
const SOURCES_PATH = path.join(DATA_DIR, "sources.json");
const PENDING_PATH = path.join(DATA_DIR, "pending-review.json");
const WHATSAPP_PATH = path.join(OUTPUT_DIR, "whatsapp-message.txt");

async function loadExistingEvents(): Promise<EventsData | null> {
  try {
    const raw = await readFile(EVENTS_PATH, "utf-8");
    return EventsDataSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

interface SourcesMeta {
  schoolName: string;
  timezone: string;
  sectionRules: SectionRule[];
  laneSections: Partial<Record<Lane, string[]>>;
}

async function loadSourcesMeta(): Promise<SourcesMeta | null> {
  try {
    const raw = await readFile(SOURCES_PATH, "utf-8");
    const config = SourcesConfigSchema.parse(JSON.parse(raw));
    return {
      schoolName: config.school_name,
      timezone: config.timezone,
      sectionRules: config.sectionRules,
      laneSections: laneSectionsFrom(config.sources, config.sectionRules),
    };
  } catch {
    return null;
  }
}

/**
 * Section headings per lane, in the order their sources appear in config, with
 * any heading introduced by a title rule appended. Published with the data so the
 * frontend can group without repeating the names.
 */
export function laneSectionsFrom(
  sources: SourceConfigEntry[],
  sectionRules: SectionRule[],
): Partial<Record<Lane, string[]>> {
  const byLane: Partial<Record<Lane, string[]>> = {};
  const addSection = (lane: Lane, section: string) => {
    const sections = (byLane[lane] ??= []);
    if (!sections.includes(section)) sections.push(section);
  };

  for (const source of sources) {
    if (source.enabled && source.section) addSection(laneForSource(source), source.section);
  }
  // A rule can name a section no enabled source declares.
  for (const lane of Object.keys(byLane) as Lane[]) {
    for (const rule of sectionRules) addSection(lane, rule.section);
  }
  return byLane;
}

/**
 * The admin-editable data/sources.json is the authority for the school name,
 * so renaming the school never means hand-editing generated data. The previous
 * dataset's name is the fallback: an unreadable config must not silently
 * rename the school on the published dashboard.
 */
export function resolveSchoolName(
  configuredName: string | null,
  existingName: string | null,
): string {
  return configuredName ?? existingName ?? "School";
}

/** Lower number = higher priority, matching data/sources.json. */
function higherPriority(
  first: SourceConfigEntry,
  second: SourceConfigEntry,
): SourceConfigEntry {
  return first.priority <= second.priority ? first : second;
}

/**
 * Which of the three dashboard lanes a source feeds. A source can set `lane`
 * explicitly in data/sources.json; otherwise it is inferred from the type.
 * ClassDojo digests arrive as mail, so they must opt in to the classdojo lane
 * rather than being inferred into the email one.
 */
export function laneForSource(source: SourceConfigEntry): Lane {
  if (source.lane) return source.lane;
  if (source.type === "newsletter_board" || source.type === "google_doc") return "newsletter";
  if (/classdojo/i.test(source.name)) return "classdojo";
  return "email";
}

/** Sender shown on a row — a role, never a person. */
function roleForSource(source: SourceConfigEntry): string | undefined {
  return source.role ?? source.name;
}

/**
 * Section an item belongs to. A title rule wins over the source's own section,
 * so a recognisable publication files correctly no matter who forwarded it.
 */
export function sectionFor(
  title: string,
  sourceSection: string | undefined,
  rules: SectionRule[],
): string | undefined {
  for (const rule of rules) {
    try {
      if (new RegExp(rule.titlePattern, "i").test(title)) return rule.section;
    } catch {
      // A malformed pattern in config must not break the whole run.
    }
  }
  return sourceSection;
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
  sectionRules: SectionRule[] = [],
): { merged: SchoolEvent[]; changes: ChangeLogEntry[] } {
  const changes: ChangeLogEntry[] = [];
  const byId = new Map(existing.map((event) => [event.id, event]));
  const seenIds = new Set<string>();

  interface Candidate {
    event: SchoolEvent;
    source: SourceConfigEntry;
  }

  const candidates: Candidate[] = [];
  for (const extraction of extractions) {
    for (const candidate of extraction.events) {
      candidates.push({
        event: {
          id: `${slugify(candidate.title)}-${candidate.date}`,
          date: candidate.date,
          time: candidate.time,
          title: candidate.title,
          category: candidate.category,
          description: candidate.description,
          importance: candidate.importance,
          uncertain: candidate.uncertain,
          whole_school: extraction.source.wholeSchool,
          // Carried through so the reverse-chronological lanes can sort by the
          // real arrival instant rather than falling back to the calendar date.
          ...(candidate.received_at ? { received_at: candidate.received_at } : {}),
          source: {
            name: extraction.source.name,
            url: extraction.source.url,
            lane: laneForSource(extraction.source),
            role: roleForSource(extraction.source),
            ...(() => {
              const section = sectionFor(candidate.title, extraction.source.section, sectionRules);
              return section ? { section } : {};
            })(),
          },
        },
        source: extraction.source,
      });
    }
  }

  // Conflict detection groups by title, but a title appearing on several dates
  // is only a conflict when *different sources* disagree about when it happens.
  // One source legitimately reports the same title on several dates (e.g. two
  // Q1 conference days); collapsing those would silently drop an occurrence.
  const byTitle = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = slugify(candidate.event.title);
    const bucket = byTitle.get(key) ?? [];
    bucket.push(candidate);
    byTitle.set(key, bucket);
  }

  const surviving: Candidate[] = [];
  for (const [, group] of byTitle) {
    const sourceNames = new Set(group.map((candidate) => candidate.source.name));
    const dates = new Set(group.map((candidate) => candidate.event.date));

    if (sourceNames.size > 1 && dates.size > 1) {
      const winner = group.reduce((best, cur) =>
        higherPriority(best.source, cur.source) === cur.source ? cur : best,
      ).source;
      console.log(
        `  CONFLICT "${group[0]!.event.title}": ${[...dates].join(" vs ")} — using ${winner.name} (highest priority)`,
      );
      surviving.push(...group.filter((candidate) => candidate.source.name === winner.name));
    } else {
      surviving.push(...group);
    }
  }

  // Collapse identical (title, date) reports, keeping the highest-priority
  // source so the dashboard cites the most authoritative link.
  const bestById = new Map<string, Candidate>();
  for (const candidate of surviving) {
    const existingBest = bestById.get(candidate.event.id);
    if (!existingBest || higherPriority(existingBest.source, candidate.source) === candidate.source) {
      bestById.set(candidate.event.id, candidate);
    }
  }

  const merged: SchoolEvent[] = [];
  for (const { event } of bestById.values()) {
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

  merged.sort(
    (first, second) =>
      first.date.localeCompare(second.date) || first.title.localeCompare(second.title),
  );
  return { merged, changes };
}

function buildWhatsAppMessage(schoolName: string, weekLabel: string, weekEvents: SchoolEvent[], dashboardUrl: string): string {
  const important = weekEvents.filter((event) => event.importance === "high");
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

  // Loaded before the merge: section rules are applied while events are built.
  const meta = await loadSourcesMeta();

  const { merged, changes } = extractions.length > 0
    ? mergeEvents(existingEvents, extractions, meta?.sectionRules ?? [])
    : { merged: existingEvents, changes: [] as ChangeLogEntry[] };

  const newCount = changes.filter((change) => change.type === "new").length;
  const changedCount = changes.filter((change) => change.type === "changed").length;
  console.log(`New events: ${newCount}`);
  console.log(`Changed events: ${changedCount}`);
  console.log(`Removed events: 0`);
  for (const change of changes.filter((change) => change.type === "changed")) {
    console.log(`CHANGED:\n${change.event.title}\n${change.previous?.date} -> ${change.event.date}\nSource: ${change.event.source.name}`);
  }

  const schoolName = resolveSchoolName(meta?.schoolName ?? null, existing?.school_name ?? null);
  const timezone = meta?.timezone ?? existing?.timezone ?? "UTC";
  // Newest newsletter digest wins; keep the previous one if this run had none, so
  // a fetch failure doesn't blank the Newsletter panel.
  const newsletter =
    extractions.find((extraction) => extraction.newsletter)?.newsletter ?? existing?.newsletter ?? undefined;

  const eventsData: EventsData = {
    school_name: schoolName,
    lane_sections: meta?.laneSections ?? existing?.lane_sections ?? {},
    timezone,
    ...(newsletter ? { newsletter } : {}),
    last_updated: new Date().toISOString(),
    events: merged,
  };

  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
  await writeFile(EVENTS_PATH, JSON.stringify(eventsData, null, 2), "utf-8");

  const weekRange = getCurrentWeekRange();
  const weekEvents = merged.filter((event) => isWithinRange(event.date, weekRange));

  const weekLabel = new Date(`${weekRange.weekStart}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
  const message = buildWhatsAppMessage(schoolName, weekLabel, weekEvents, dashboardUrl);
  await writeFile(WHATSAPP_PATH, message, "utf-8");

  // Deliberately does NOT print "Deployment ready" — validation runs after this
  // and may still reject the data, so claiming readiness here would be wrong.
  console.log("  OK   Dashboard generated");
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
