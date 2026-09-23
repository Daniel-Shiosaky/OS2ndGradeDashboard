import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classDojoApiPath, parseClassDojo } from "../src/shared/parseClassDojo.js";
import { namesFromEnv, redactPersonalNames } from "../src/shared/redact.js";

const fixture = (name: string) =>
  readFileSync(path.resolve(import.meta.dirname, `fixtures/${name}`), "utf-8");

// Both fixtures mirror the live API shapes, with invented names. The real
// responses carry a teacher's name, a classroom name and family surnames, so
// committing them to a public repo would be the leak this code prevents.
const CALENDAR = fixture("classdojo-calendar.json");
const STORY = fixture("classdojo-storyfeed.json");

const ZONE = "America/New_York";
const NAMES = ["Childname"];

describe("classDojoApiPath", () => {
  it("maps the story page to the story feed, excluding comments and synthetic posts", () => {
    const p = classDojoApiPath("https://home.classdojo.com/#/story");
    expect(p).toContain("/api/storyFeed");
    // Not requesting comments means other children's names never arrive at all.
    expect(p).toContain("withStudentCommentsAndLikes=false");
    expect(p).toContain("withSyntheticPosts=false");
  });

  it("maps anything else to the calendar feed with past events filtered server-side", () => {
    const p = classDojoApiPath("https://home.classdojo.com/#/events");
    expect(p).toContain("/api/parentCalendarEvent");
    expect(p).toContain("hidePastEvents=true");
  });
});

describe("redactPersonalNames", () => {
  it("keeps staff names, who are named in a professional capacity", () => {
    expect(redactPersonalNames("Mrs. Example's Class")).toBe("Mrs. Example's Class");
  });

  it("replaces a family surname with a neutral phrase", () => {
    // Live feed: "Fruit pops courtesy of the Testfamily family!"
    expect(redactPersonalNames("courtesy of the Testfamily family!")).toBe("courtesy of a family!");
  });

  it("removes configured bare first names, which no pattern can infer", () => {
    expect(redactPersonalNames("Childname's story", NAMES)).toBe("story");
  });

  it("leaves ordinary text alone", () => {
    expect(redactPersonalNames("The Math Quiz will be Wednesday 9/23")).toBe(
      "The Math Quiz will be Wednesday 9/23",
    );
  });
});

describe("namesFromEnv", () => {
  it("splits the comma-separated list", () => {
    expect(namesFromEnv({ REDACT_NAMES: "Ada, Grace ,Alan" })).toEqual(["Ada", "Grace", "Alan"]);
  });

  it("returns nothing when unset", () => {
    expect(namesFromEnv({})).toEqual([]);
  });
});

describe("parseClassDojo — calendar feed", () => {
  const { events } = parseClassDojo(
    "https://home.classdojo.com/#/events",
    CALENDAR,
    ZONE,
    NAMES,
  );

  it("uses the API's local start date rather than deriving it from UTC", () => {
    // 2026-09-25T17:50Z is still the 25th in New York; a naive UTC read of a
    // late-evening event would land on the wrong day.
    expect(events.map((e) => e.date)).toEqual(["2026-09-25", "2026-10-01"]);
  });

  it("formats the start time in the event's own timezone", () => {
    expect(events[0]).toMatchObject({ title: "Hispanic Heritage Open Mic", time: "1:50 PM" });
  });

  it("leaves all-day events without a time", () => {
    expect(events[1]?.time).toBeNull();
  });

  it("keeps the description, which the rendered page never exposed", () => {
    expect(events[0]?.description).toContain("dedicated to Hispanic Heritage");
  });

  it("categorises a quiz as high importance", () => {
    expect(events[1]).toMatchObject({ category: "quiz", importance: "high" });
  });

  it("reads only title, date and description — never the teacher or classroom fields", () => {
    // Staff names are allowed in text the school wrote, but these structural
    // fields are not content and are never surfaced.
    const all = JSON.stringify(events);
    expect(CALENDAR).toContain("Mrs. Example's Class");
    expect(all).not.toMatch(/classroom|teacher|firstName|lastName/i);
  });
});

describe("parseClassDojo — story feed", () => {
  const { events, redactedItems } = parseClassDojo(
    "https://home.classdojo.com/#/story",
    STORY,
    ZONE,
    NAMES,
  );

  it("returns posts newest first using the API timestamp", () => {
    const received = events.map((e) => e.received_at ?? "");
    expect([...received].sort((a, b) => b.localeCompare(a))).toEqual(received);
    expect(events[0]?.received_at).toBe("2026-09-23T01:22:48.104Z");
  });

  it("resolves the calendar date in the school's timezone", () => {
    // 2026-09-23T01:22Z is still the 22nd in New York.
    expect(events[0]?.date).toBe("2026-09-22");
  });

  it("keeps the full body for the detail view", () => {
    expect(events[0]?.description).toContain("dressed in uniform instead of PE clothes");
    expect(events[0]?.category).toBe("announcement");
  });

  it("publishes no child or family names", () => {
    const all = events.map((e) => `${e.title} ${e.description}`).join(" ");
    expect(all).not.toMatch(/Testfamily|Childname/);
    expect(all).toContain("courtesy of a family");
  });

  it("drops the credential lines but keeps the rest of that post", () => {
    const post = events.find((e) => /Reading challenge/.test(e.description));
    expect(post).toBeDefined();
    expect(post?.description).toContain("log 20 minutes of practice");
    expect(post?.description).not.toMatch(/password|username|@scholars/i);
  });

  it("skips synthetic CLASS EVENT reposts that duplicate the calendar", () => {
    expect(STORY).toContain("CLASS EVENT");
    expect(events.map((e) => e.title).join(" ")).not.toMatch(/Fall Conferences/);
  });

  it("withholds posts with nothing school-actionable", () => {
    expect(events.map((e) => e.description).join(" ")).not.toMatch(/lovely time at the celebration/);
    expect(redactedItems).toBeGreaterThan(0);
  });

  it("keeps the post correcting the newsletter's quiz dates", () => {
    const correction = events.find((e) => /Math Quiz will be Wednesday/.test(e.description));
    expect(correction?.description).toContain("North America Map test");
  });
});

describe("parseClassDojo robustness", () => {
  it("returns nothing for a malformed response instead of throwing", () => {
    expect(parseClassDojo("#/story", "not json", ZONE).events).toEqual([]);
    expect(parseClassDojo("#/events", "{}", ZONE).events).toEqual([]);
  });
});
