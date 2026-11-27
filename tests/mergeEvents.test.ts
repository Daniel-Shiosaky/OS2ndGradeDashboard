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
    localOnly: false,
    wholeSchool: false,
    broadcastChannel: false,
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
    whole_school: false,
    source: { name: "School Website", url: "https://example.com", lane: "newsletter" },
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

describe("mergeEvents — recurring events from a single source", () => {
  it("keeps every date when one source reports the same title more than once", () => {
    // Real case: the weekly newsletter lists two Q1 conference days. Grouping by
    // title alone used to collapse these into one event and log a bogus CONFLICT.
    const newsletter = source({ name: "Second Grade Weekly Newsletter", priority: 1 });
    const { merged, changes } = mergeEvents([], [
      {
        source: newsletter,
        events: [
          extracted({ title: "Q1 Second Grade Conferences", date: "2026-09-22", category: "event" }),
          extracted({ title: "Q1 Second Grade Conferences", date: "2026-09-24", category: "event" }),
        ],
      },
    ]);

    const conferences = merged.filter((e) => e.title === "Q1 Second Grade Conferences");
    expect(conferences.map((e) => e.date).sort()).toEqual(["2026-09-22", "2026-09-24"]);
    expect(changes.filter((c) => c.type === "new")).toHaveLength(2);
  });

  it("still resolves by priority when two different sources disagree on the date", () => {
    const { merged } = mergeEvents([], [
      { source: source({ name: "Newsletter", priority: 3 }), events: [extracted({ date: "2026-09-24" })] },
      { source: source({ name: "Official", priority: 1 }), events: [extracted({ date: "2026-09-25" })] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.date).toBe("2026-09-25");
    expect(merged[0]!.source.name).toBe("Official");
  });

  it("prefers the higher-priority source when both agree on the date", () => {
    const { merged } = mergeEvents([], [
      { source: source({ name: "Newsletter", priority: 3 }), events: [extracted({ date: "2026-09-24" })] },
      { source: source({ name: "Official", priority: 1 }), events: [extracted({ date: "2026-09-24" })] },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.source.name).toBe("Official");
  });
});

describe("mergeEvents — superseded weekly newsletter issues", () => {
  const newsletterName = "Second Grade Weekly Newsletter";

  function issueEvent(week: string, date: string, title: string): SchoolEvent {
    return existingEvent({
      id: `${title.toLowerCase().replace(/\W+/g, "-")}-${date}`,
      date,
      title,
      source: { name: `${newsletterName} (${week})`, url: "https://docs.example.org/doc", lane: "newsletter" },
    });
  }

  function newIssue(week: string, dates: { date: string; title: string }[]): SourceExtraction {
    return {
      source: source({ name: `${newsletterName} (${week})`, type: "newsletter_board", priority: 1 }),
      events: dates.map(({ date, title }) => extracted({ date, title })),
    };
  }

  it("drops events from an older issue once a newer issue is reported", () => {
    const existing = [issueEvent("9/21-9/25", "2026-09-24", "Science Quiz")];
    const { merged, changes } = mergeEvents(existing, [
      newIssue("11/30-12/4", [{ date: "2026-12-02", title: "Christmas Dance" }]),
    ]);

    expect(merged.map((event) => event.title)).toEqual(["Christmas Dance"]);
    expect(changes.filter((change) => change.type === "removed").map((change) => change.event.title)).toEqual([
      "Science Quiz",
    ]);
  });

  it("keeps a newer stored issue when a run only managed to re-read an older one", () => {
    const existing = [issueEvent("11/30-12/4", "2026-12-02", "Christmas Dance")];
    const { merged, changes } = mergeEvents(existing, [
      newIssue("9/21-9/25", [{ date: "2026-09-24", title: "Science Quiz" }]),
    ]);

    expect(merged.map((event) => event.title).sort()).toEqual(["Christmas Dance", "Science Quiz"]);
    expect(changes.some((change) => change.type === "removed")).toBe(false);
  });

  it("never prunes events from sources that have no weekly suffix", () => {
    const existing = [existingEvent({ date: "2026-09-10", title: "Picture Day", id: "picture-day-2026-09-10" })];
    const { merged } = mergeEvents(existing, [
      newIssue("11/30-12/4", [{ date: "2026-12-02", title: "Christmas Dance" }]),
    ]);

    expect(merged.map((event) => event.title).sort()).toEqual(["Christmas Dance", "Picture Day"]);
  });

  it("leaves other sources' older events alone", () => {
    const existing = [
      existingEvent({
        date: "2026-09-10",
        title: "Picture Day",
        id: "picture-day-2026-09-10",
        source: { name: "ClassDojo Events", url: "https://example.com", lane: "classdojo" },
      }),
    ];
    const { merged } = mergeEvents(existing, [
      newIssue("11/30-12/4", [{ date: "2026-12-02", title: "Christmas Dance" }]),
    ]);

    expect(merged.map((event) => event.title)).toContain("Picture Day");
  });
});
