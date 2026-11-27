import { describe, expect, it } from "vitest";
import { laneForSource, sectionFor } from "../src/scripts/generateDashboard.js";
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
