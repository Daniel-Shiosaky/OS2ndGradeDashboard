import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseNewsletter, redactNames } from "../src/shared/parseNewsletter.js";

// The real 9/21-9/25 newsletter, exactly as the Google Doc export returns it.
const FIXTURE = readFileSync(
  path.resolve(import.meta.dirname, "fixtures/newsletter-2026-09-21.txt"),
  "utf-8",
);
const TODAY = new Date("2026-09-22T12:00:00Z");

describe("redactNames", () => {
  it("keeps staff names, which carry meaning the dashboard needs", () => {
    // The newsletter lists one conference day per teacher; removing the names
    // produced two identical rows with no way to tell them apart.
    expect(redactNames("Mrs. Rivera's Q1 Conferences")).toBe("Mrs. Rivera's Q1 Conferences");
    expect(redactNames("a dance under the direction of Ms. Kevi")).toBe(
      "a dance under the direction of Ms. Kevi",
    );
  });

  it("still removes another family's surname", () => {
    expect(redactNames("Fruit pops courtesy of the Testfamily family!")).toBe(
      "Fruit pops courtesy of a family!",
    );
  });

  it("closes up a gap left where a redacted name preceded punctuation", () => {
    expect(redactNames("snacks from the Othername Family .")).toBe("snacks from a family.");
  });

  it("removes a configured child name", () => {
    expect(redactNames("Childname's reading log", ["Childname"])).toBe("reading log");
  });

  it("leaves text with no names alone", () => {
    expect(redactNames("Ch. 3 Quiz")).toBe("Ch. 3 Quiz");
  });
});

describe("parseNewsletter on the real newsletter", () => {
  const { events, redactedLines } = parseNewsletter(FIXTURE, TODAY);

  it("finds every dated item in the newsletter", () => {
    expect(events).toHaveLength(9);
  });

  it("resolves the bare M/D dates to the correct year", () => {
    expect(events.map((e) => e.date)).toEqual([
      "2026-09-22",
      "2026-09-23",
      "2026-09-24",
      "2026-09-24",
      "2026-09-25",
      "2026-09-25",
      "2026-09-25",
      "2026-09-30",
      "2026-10-02",
    ]);
  });

  it("keeps both conference days rather than collapsing them", () => {
    const conferences = events.filter((e) => /conference/i.test(e.title));
    expect(conferences).toHaveLength(2);
    expect(conferences.map((e) => e.date)).toEqual(["2026-09-22", "2026-09-24"]);
  });

  it("categorises tests, quizzes, homework and projects", () => {
    const byTitle = (needle: string) => events.find((e) => e.title.includes(needle));
    expect(byTitle("Ch. 3 Quiz")?.category).toBe("quiz");
    expect(byTitle("Spelling test")?.category).toBe("test");
    expect(byTitle("Map test")?.category).toBe("test");
    expect(byTitle("Backpack")?.category).toBe("homework");
    expect(byTitle("Workbook")?.category).toBe("homework");
    expect(byTitle("Bible Presentation")?.category).toBe("project");
    expect(byTitle("Conferences")?.category).toBe("event");
  });

  it("labels subject items with their section for context", () => {
    expect(events.some((e) => e.title === "Math — Ch. 3 Quiz")).toBe(true);
    expect(events.some((e) => e.title.startsWith("ELA — "))).toBe(true);
  });

  it("marks tests, quizzes and projects as high importance", () => {
    for (const event of events) {
      if (["test", "quiz", "project"].includes(event.category)) {
        expect(event.importance).toBe("high");
      }
    }
  });

  it("distinguishes the two per-teacher conference days", () => {
    // This is the reason staff names are kept: both fall under "Q1 Conferences"
    // on different dates, and without the names the rows are indistinguishable.
    const conferences = events.filter((e) => /Conferences/.test(e.title));
    expect(conferences).toHaveLength(2);
    expect(new Set(conferences.map((e) => e.title)).size).toBe(2);
    expect(conferences.some((e) => e.title.includes("Rivera") && e.date === "2026-09-22")).toBe(true);
    expect(conferences.some((e) => e.title.includes("Holmes") && e.date === "2026-09-24")).toBe(true);
  });

  it("publishes no child or family names", () => {
    const published = events.map((e) => `${e.title} ${e.description}`).join(" ");
    expect(published).not.toMatch(/Childname/);
    expect(published).not.toMatch(/Testfamily|Othername|Thirdname/);
  });

  it("drops the credential lines the newsletter contains", () => {
    // The fixture really does carry "Username: ..." and "Password: Scholar's birthdate".
    expect(FIXTURE).toMatch(/Password/);
    const published = events.map((e) => `${e.title} ${e.description}`).join(" ");
    expect(published).not.toMatch(/password/i);
    expect(published).not.toMatch(/username/i);
    expect(published).not.toMatch(/@scholars/i);
    expect(redactedLines).toBeGreaterThan(0);
  });

  it("produces events that satisfy the published schema shape", () => {
    for (const event of events) {
      expect(event.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(event.title.length).toBeGreaterThan(0);
      expect(event.uncertain).toBe(false);
    }
  });
});

describe("parseNewsletter fallback behaviour", () => {
  it("returns nothing when the template no longer matches, rather than guessing", () => {
    const { events } = parseNewsletter(
      "Welcome to our newsletter! Lots of news this week but no dates at all.",
      TODAY,
    );
    expect(events).toEqual([]);
  });

  it("returns nothing for empty input", () => {
    expect(parseNewsletter("", TODAY).events).toEqual([]);
  });

  it("ignores a weekday with no date beside it", () => {
    expect(parseNewsletter("Spelling test on Friday", TODAY).events).toEqual([]);
  });
});

describe("parseNewsletter section outline", () => {
  const { sections } = parseNewsletter(FIXTURE, TODAY);
  const find = (h: string) => sections.find((s) => s.heading === h);

  it("mirrors the newsletter's own sub-sections", () => {
    expect(sections.map((s) => s.heading)).toEqual([
      "Classwork — ELA",
      "Classwork — Math",
      "Classwork — Social Studies",
      "Classwork — Bible",
      "Classwork — Other",
      "Homework — Monday",
    ]);
  });

  it("keeps Classwork's and Homework's separate 'Other' blocks apart", () => {
    // Both blocks carry an "Other" heading; merging them would mix homework
    // into classwork.
    const others = sections.filter((s) => s.heading.endsWith("Other"));
    expect(others.every((s) => s.heading.startsWith("Classwork"))).toBe(true);
  });

  it("drops the empty weekday headings the template ships every week", () => {
    // Tuesday-Friday homework headings exist in the doc but have no content.
    for (const day of ["Tuesday", "Wednesday", "Thursday", "Friday"]) {
      expect(find(`Homework — ${day}`)).toBeUndefined();
    }
  });

  it("rejoins a sentence the doc export hard-wrapped across lines", () => {
    const bible = find("Classwork — Bible");
    expect(bible?.items).toContain(
      "Trust in the Lord with all your heart and lean not on your own understanding; in all your ways acknowledge him, and he will make your paths straight.",
    );
  });

  it("does not glue a new capitalised topic onto the previous item", () => {
    const bible = find("Classwork — Bible");
    expect(bible?.items).toContain("Exploring Egypt");
    expect(bible?.items).toContain("Bible Verse: Proverbs 3:5-6 Song");
    const other = find("Classwork — Other");
    expect(other?.items).toContain("Hispanic Heritage Showcase");
  });

  it("preserves a leading dash used as a spelling pattern", () => {
    expect(find("Classwork — ELA")?.items).toContain("–le and -nh");
  });

  it("carries undated content that never became an event", () => {
    // "Open Mic will begin at 1:50pm" has no date, so it is correctly not an
    // event — but the parent should still be able to read it.
    expect(find("Classwork — Other")?.items).toContain("Open Mic will begin at 1:50pm");
  });

  it("keeps child names and credentials out of the outline too", () => {
    const all = sections.flatMap((s) => s.items).join(" ");
    expect(all).not.toMatch(/Childname/);
    expect(all).not.toMatch(/password|username|@scholars/i);
  });

  it("carries the staff names the outline needs to stay unambiguous", () => {
    const other = sections.find((s) => s.heading === "Classwork — Other");
    expect(other?.items.some((i) => /Rivera/.test(i))).toBe(true);
    expect(other?.items.some((i) => /Holmes/.test(i))).toBe(true);
  });

  it("returns no sections when the template does not match", () => {
    expect(parseNewsletter("Just some prose with no headings.", TODAY).sections).toEqual([]);
  });
});
