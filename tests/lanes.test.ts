import { describe, expect, it } from "vitest";
import { laneForSource, laneSectionsFrom, sectionFor } from "../src/scripts/generateDashboard.js";
import type { SourceConfigEntry } from "../src/types/schema.js";

function source(overrides: Partial<SourceConfigEntry> = {}): SourceConfigEntry {
  return {
    name: "Some Source",
    type: "gmail",
    enabled: true,
    localOnly: false,
    wholeSchool: false,
    broadcastChannel: false,
    priority: 5,
    ...overrides,
  };
}

describe("laneForSource", () => {
  it("routes the weekly newsletter and public docs to the Newsletter lane", () => {
    expect(laneForSource(source({ type: "newsletter_board" }))).toBe("newsletter");
    expect(laneForSource(source({ type: "google_doc" }))).toBe("newsletter");
  });

  it("routes ordinary mailboxes to the Email lane", () => {
    expect(laneForSource(source({ name: "Teacher Emails", type: "gmail" }))).toBe("email");
  });

  it("recognises a ClassDojo digest mailbox despite it arriving as mail", () => {
    // Without this, ClassDojo digests would land in the Email lane and the
    // ClassDojo lane would never fill.
    expect(laneForSource(source({ name: "ClassDojo Digest Emails", type: "gmail" }))).toBe(
      "classdojo",
    );
  });

  it("lets an explicit lane in the config override the inferred one", () => {
    expect(laneForSource(source({ name: "Teacher Emails", lane: "classdojo" }))).toBe("classdojo");
    expect(laneForSource(source({ type: "newsletter_board", lane: "email" }))).toBe("email");
  });
});

describe("data/sources.json lane wiring", () => {
  it("assigns every configured source to a lane with a role label", async () => {
    const { SourcesConfigSchema } = await import("../src/types/schema.js");
    const raw = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../data/sources.json", import.meta.url), "utf-8"),
    );
    const config = SourcesConfigSchema.parse(JSON.parse(raw));

    for (const entry of config.sources) {
      expect(laneForSource(entry)).toBeTruthy();
      // Senders are shown by role, never by person.
      expect(entry.role, `${entry.name} needs a role label`).toBeTruthy();
      expect(entry.role).not.toMatch(/\b(?:Mrs|Mr|Ms|Miss|Dr)\.?\s+[A-Z]/);
    }
  });

  it("uses the grade as the dashboard title, not a school or person", async () => {
    // One shared dashboard for the whole 2nd grade: both classes use the same
    // newsletter, so there is no per-class or per-child split.
    const raw = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../data/sources.json", import.meta.url), "utf-8"),
    );
    expect(JSON.parse(raw).school_name).toBe("2nd Grade");
  });
});

describe("sectionFor", () => {
  const rules = [{ titlePattern: "Inside the Spark", section: "General announcements" }];

  it("files a recognised publication by title, whatever source forwarded it", () => {
    expect(sectionFor("Inside the Spark | One School Newsletter", "Teachers", rules)).toBe(
      "General announcements",
    );
  });

  it("falls back to the source's own section", () => {
    expect(sectionFor("Happy Monday!", "Teachers", rules)).toBe("Teachers");
  });

  it("returns undefined when neither a rule nor a source section applies", () => {
    expect(sectionFor("Happy Monday!", undefined, rules)).toBeUndefined();
  });

  it("matches case-insensitively", () => {
    expect(sectionFor("inside the spark weekly", undefined, rules)).toBe("General announcements");
  });

  it("ignores a malformed pattern rather than breaking the run", () => {
    const bad = [{ titlePattern: "([unclosed", section: "Nope" }];
    expect(sectionFor("anything", "Teachers", bad)).toBe("Teachers");
  });
});

describe("Calendar lane", () => {
  it("routes an iCalendar feed to the Calendar lane", () => {
    expect(laneForSource(source({ name: "School Calendar (MyOS)", type: "ical_feed" }))).toBe("calendar");
  });

  it("keeps the private feed URL out of the committed config", async () => {
    const { SourcesConfigSchema } = await import("../src/types/schema.js");
    const raw = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("../data/sources.json", import.meta.url), "utf-8"),
    );
    const feed = SourcesConfigSchema.parse(JSON.parse(raw)).sources.find((entry) => entry.type === "ical_feed");
    expect(feed).toBeDefined();
    expect(feed?.url).toBeUndefined();
    expect(feed?.urlEnv).toBeTruthy();
    // It needs no login, so CI must be able to run it.
    expect(feed?.localOnly).toBe(false);
    expect(raw).not.toMatch(/iCal\.aspx|podium\/feed|webcal:/i);
  });
});

describe("lane-scoped section rules", () => {
  const rules = [
    { titlePattern: "Inside the Spark", section: "General announcements" },
    { lane: "calendar" as const, titlePattern: "early release|no school", section: "Schedule changes" },
    { lane: "calendar" as const, titlePattern: ".*", section: "School events" },
  ];

  it("files a calendar item by a calendar-scoped rule, first match wins", () => {
    expect(sectionFor("Early Release Day", undefined, rules, "calendar")).toBe("Schedule changes");
    expect(sectionFor("Picture Day", undefined, rules, "calendar")).toBe("School events");
  });

  it("never applies a calendar-scoped rule to another lane's item", () => {
    // The catch-all would otherwise file every email under "School events".
    expect(sectionFor("Happy Monday!", "Teachers", rules, "email")).toBe("Teachers");
    expect(sectionFor("Early Release Day", "Teachers", rules, "email")).toBe("Teachers");
  });

  it("still applies an unscoped rule in any lane", () => {
    expect(sectionFor("Inside the Spark | Newsletter", "Teachers", rules, "email")).toBe("General announcements");
  });

  it("builds the calendar lane's sections from its rules, without leaking unscoped ones", () => {
    const sources = [
      source({ name: "Teacher Emails", type: "gmail", lane: "email", section: "Teachers" }),
      source({ name: "School Calendar", type: "ical_feed", urlEnv: "FEED", lane: "calendar" }),
    ];
    expect(laneSectionsFrom(sources, rules)).toEqual({
      email: ["Teachers", "General announcements"],
      calendar: ["Schedule changes", "School events"],
    });
  });
});
