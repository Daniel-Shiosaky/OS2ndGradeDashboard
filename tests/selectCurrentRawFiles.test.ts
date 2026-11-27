import { describe, expect, it } from "vitest";
import { selectCurrentRawFiles } from "../src/scripts/processWithAi.js";
import type { SourceConfigEntry } from "../src/types/schema.js";

function configured(name: string, overrides: Partial<SourceConfigEntry> = {}): SourceConfigEntry {
  return {
    name,
    type: "newsletter_board",
    enabled: true,
    localOnly: false,
    wholeSchool: false,
    broadcastChannel: false,
    priority: 1,
    ...overrides,
  };
}

function rawFile(fileName: string, name: string, fetchedAt: string) {
  return { fileName, fetched: { source: { name }, fetchedAt } };
}

const newsletterConfig = configured("Second Grade Weekly Newsletter");

describe("selectCurrentRawFiles", () => {
  it("keeps only the most recently fetched weekly newsletter", () => {
    const { current, skipped } = selectCurrentRawFiles(
      [
        rawFile("newsletter-9-21.json", "Second Grade Weekly Newsletter (9/21-9/25)", "2026-09-23T11:44:00Z"),
        rawFile("newsletter-11-30.json", "Second Grade Weekly Newsletter (11/30-12/4)", "2026-11-27T22:00:00Z"),
      ],
      [newsletterConfig],
    );
    expect(current.map((entry) => entry.fileName)).toEqual(["newsletter-11-30.json"]);
    expect(skipped.map((entry) => entry.fileName)).toEqual(["newsletter-9-21.json"]);
  });

  it("keeps the newest newsletter whichever order the files are listed in", () => {
    const { current } = selectCurrentRawFiles(
      [
        rawFile("newsletter-11-30.json", "Second Grade Weekly Newsletter (11/30-12/4)", "2026-11-27T22:00:00Z"),
        rawFile("newsletter-9-21.json", "Second Grade Weekly Newsletter (9/21-9/25)", "2026-09-23T11:44:00Z"),
      ],
      [newsletterConfig],
    );
    expect(current.map((entry) => entry.fileName)).toEqual(["newsletter-11-30.json"]);
  });

  it("skips files for sources that were removed from the config", () => {
    const { current, skipped } = selectCurrentRawFiles(
      [
        rawFile("teacher-emails.json", "Teacher Emails", "2026-11-27T22:00:00Z"),
        rawFile("school-website.json", "School Website", "2026-09-22T18:47:00Z"),
      ],
      [configured("Teacher Emails", { type: "gmail" })],
    );
    expect(current.map((entry) => entry.fileName)).toEqual(["teacher-emails.json"]);
    expect(skipped).toEqual([
      { fileName: "school-website.json", reason: "not an enabled source in data/sources.json" },
    ]);
  });

  it("skips files for sources that are configured but disabled", () => {
    const { current } = selectCurrentRawFiles(
      [rawFile("digest.json", "ClassDojo Digest Emails", "2026-09-22T18:47:00Z")],
      [], // enabled sources only: a disabled one is simply absent
    );
    expect(current).toEqual([]);
  });

  it("does not treat a source whose name merely starts with another's as the same source", () => {
    const { current } = selectCurrentRawFiles(
      [
        rawFile("events.json", "ClassDojo Events", "2026-11-27T22:00:00Z"),
        rawFile("story.json", "ClassDojo Class Story", "2026-11-27T22:00:00Z"),
      ],
      [configured("ClassDojo Events", { type: "classdojo" }), configured("ClassDojo Class Story", { type: "classdojo" })],
    );
    expect(current.map((entry) => entry.fileName).sort()).toEqual(["events.json", "story.json"]);
  });
});
