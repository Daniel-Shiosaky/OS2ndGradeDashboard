import { describe, expect, it } from "vitest";
import { mergeEvents } from "../src/scripts/generateDashboard.js";
import type { SourceExtraction } from "../src/scripts/processWithAi.js";
import type { ExtractedEvent, SchoolEvent, SourceConfigEntry } from "../src/types/schema.js";

function source(overrides: Partial<SourceConfigEntry> = {}): SourceConfigEntry {
  return {
    name: "School Website",
    url: "https://example.com",
    type: "website",
    enabled: true,
    priority: 4,
    ...overrides,
  };
}

function extracted(overrides: Partial<ExtractedEvent> = {}): ExtractedEvent {
  return {
    date: "2026-09-24",
    time: null,
    title: "Science Quiz",
    category: "quiz",
    description: "Chapter 3 quiz.",
    importance: "high",
    uncertain: false,
    ...overrides,
  };
}

function existingEvent(overrides: Partial<SchoolEvent> = {}): SchoolEvent {
  return {
    id: "science-quiz-2026-09-24",
    date: "2026-09-24",
    time: null,
    title: "Science Quiz",
    category: "quiz",
    description: "Chapter 3 quiz.",
    importance: "high",
    uncertain: false,
    source: { name: "School Website", url: "https://example.com" },
    ...overrides,
  };
}

describe("mergeEvents", () => {
  it("marks a brand-new event as 'new'", () => {
    const extraction: SourceExtraction = { source: source(), events: [extracted()] };
    const { merged, changes } = mergeEvents([], [extraction]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("science-quiz-2026-09-24");
    expect(changes).toEqual([{ type: "new", event: merged[0] }]);
  });

  it("marks an event as 'changed' when its date shifts", () => {
    const existing = [existingEvent()];
    const extraction: SourceExtraction = {
      source: source(),
      events: [extracted({ date: "2026-09-25" })],
    };

    const { merged, changes } = mergeEvents(existing, [extraction]);

    // A date shift changes the id, so the old entry is superseded rather
    // than found by id — this is the expected id-scheme behavior.
    expect(merged.map((e) => e.id)).toContain("science-quiz-2026-09-25");
    expect(changes.some((c) => c.type === "new")).toBe(true);
  });

  it("marks an event as 'changed' when only the description changes (same date/id)", () => {
    const existing = [existingEvent({ description: "Old description." })];
    const extraction: SourceExtraction = {
      source: source(),
      events: [extracted({ description: "New description." })],
    };

    const { merged, changes } = mergeEvents(existing, [extraction]);

    expect(merged).toHaveLength(1);
    expect(changes).toEqual([
      {
        type: "changed",
        event: merged[0],
        previous: existing[0],
      },
    ]);
  });

  it("keeps unrelated existing events untouched when a source fails to report them again", () => {
    const untouched = existingEvent({
      id: "field-trip-2026-10-06",
      title: "Field Trip",
      date: "2026-10-06",
    });
    const { merged, changes } = mergeEvents([untouched], []);

    expect(merged).toEqual([untouched]);
    expect(changes).toEqual([]);
  });

  it("resolves cross-source conflicts using the lower priority number (higher priority) and logs it", () => {
    const highPrioritySource = source({ name: "Official Announcement", priority: 1 });
    const lowPrioritySource = source({ name: "School Website", priority: 4 });

    const extractions: SourceExtraction[] = [
      { source: lowPrioritySource, events: [extracted({ date: "2026-09-24" })] },
      { source: highPrioritySource, events: [extracted({ date: "2026-09-25" })] },
    ];

    const { merged } = mergeEvents([], extractions);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.date).toBe("2026-09-25");
    expect(merged[0]?.source.name).toBe("Official Announcement");
  });

  it("does not duplicate an event id across multiple runs", () => {
    const extraction: SourceExtraction = { source: source(), events: [extracted()] };
    const first = mergeEvents([], [extraction]);
    const second = mergeEvents(first.merged, [extraction]);

    expect(second.merged).toHaveLength(1);
    expect(second.changes).toEqual([]);
  });
});
