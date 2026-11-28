import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyCalendarTitle,
  formatTimeRange,
  parseCalendarFeed,
} from "../src/shared/parseCalendarFeed.js";

// Synthetic: invented events and an invented child name. The real school calendar
// carries a student's name on class entries, so it is never committed.
const FIXTURE = readFileSync(path.resolve(import.meta.dirname, "fixtures/school-calendar.ics"), "utf-8");
const OPTIONS = { timeZone: "America/New_York", extraNames: ["Childname"], today: "2026-11-27" };

const { events, withheld } = parseCalendarFeed(FIXTURE, OPTIONS);
const byTitle = (title: string) => events.find((event) => event.title === title);

describe("parseCalendarFeed — what is published", () => {
  it("publishes the Winter Band Concert on Tue Dec 15 2026, 6:00-7:00 PM", () => {
    const concert = byTitle("Winter Band Concert");
    expect(concert).toBeDefined();
    expect(concert?.date).toBe("2026-12-15");
    expect(concert?.time).toBe("6:00–7:00 PM");
    expect(concert?.category).toBe("performance");
    expect(new Date("2026-12-15T12:00:00Z").getUTCDay()).toBe(2); // a Tuesday
  });

  it("keeps the location and unescaped description, with folded lines joined", () => {
    expect(byTitle("Winter Band Concert")?.description).toBe(
      "Location: Main Auditorium · Doors open at 5:30, music begins at 6:00. Please arrive early; seating is limited.",
    );
  });

  it("marks early release and no-school days as important schedule changes", () => {
    const earlyRelease = byTitle("Early Release Day - No extended care");
    expect(earlyRelease?.category).toBe("early_dismissal");
    expect(earlyRelease?.importance).toBe("high");
    expect(earlyRelease?.time).toBeNull();
    expect(byTitle("Christmas Break")?.category).toBe("no_school");
  });

  it("records the last day of a multi-day event (DTEND is exclusive for all-day items)", () => {
    expect(byTitle("Christmas Shoppe")).toMatchObject({ date: "2026-12-07", end_date: "2026-12-10" });
    expect(byTitle("Christmas Break")).toMatchObject({ date: "2026-12-21", end_date: "2027-01-04" });
    expect(byTitle("Early Release Day - No extended care")?.end_date).toBeUndefined();
  });

  it("shows times in the school's zone whatever zone the feed used", () => {
    expect(byTitle("Winter Choir Showcase")?.time).toBe("12:00–1:00 PM"); // 17:00Z
    expect(byTitle("Visiting Author Assembly")?.time).toBe("9:00–10:00 AM"); // Chicago 8:00
  });

  it("lists same-day items by start time, not by title", () => {
    const dec2 = events.filter((event) => event.date === "2026-12-02").map((event) => event.title);
    expect(dec2).toEqual(["Morning Spectacular", "Afternoon Spectacular"]);
  });

  it("sorts the whole result by date", () => {
    const dates = events.map((event) => event.date);
    expect(dates).toEqual([...dates].sort());
  });
});

describe("parseCalendarFeed — what is never published", () => {
  it("publishes no class period as an event", () => {
    const titles = events.map((event) => event.title).join(" | ");
    expect(titles).not.toMatch(/Language Arts|Math - 2A|Lunch - 2nd|2ELA|2MATH|2LUNCH/);
    expect(withheld["class-period"]).toBe(3);
  });

  it("drops a title that repeats like a daily series", () => {
    expect(events.some((event) => event.title === "Reading Block")).toBe(false);
    expect(withheld.recurring).toBeGreaterThanOrEqual(4);
  });

  it("drops an RRULE series, athletic fixtures, practices and cancelled items", () => {
    const titles = events.map((event) => event.title);
    expect(titles).not.toContain("Saturday Enrichment");
    expect(titles).not.toContain("Basketball v Rivals");
    expect(titles).not.toContain("Basketball @ Away Gym");
    expect(titles).not.toContain("Choir Practice");
    expect(titles).not.toContain("Cancelled Pizza Day");
    expect(withheld.routine).toBe(3);
    expect(withheld.cancelled).toBe(1);
  });

  it("drops events that ended long ago", () => {
    expect(events.some((event) => event.title === "Back to School Night")).toBe(false);
    expect(withheld.stale).toBe(1);
  });
});

describe("parseCalendarFeed — privacy", () => {
  it("withholds an entry naming a child whole, rather than trimming the name", () => {
    expect(events.some((event) => event.title.includes("Conference"))).toBe(false);
    expect(events.some((event) => event.title === "Class Party")).toBe(false); // named in the description
    expect(withheld["names-child"]).toBe(2);
  });

  it("never lets the child's name reach any published field", () => {
    expect(JSON.stringify(events)).not.toMatch(/Childname/i);
  });

  it("withholds an entry whose title carries a phone number", () => {
    expect(events.some((event) => event.title.includes("Office Hours"))).toBe(false);
    expect(withheld["contact-details"]).toBe(1);
  });

  it("with no names configured, a named entry is no longer caught by the name gate", () => {
    const { events: unfiltered } = parseCalendarFeed(FIXTURE, { ...OPTIONS, extraNames: [] });
    expect(unfiltered.some((event) => event.title.includes("Conference"))).toBe(true);
  });
});

describe("formatTimeRange", () => {
  it("prints the period once when both ends share it", () => {
    expect(formatTimeRange(18 * 60, 19 * 60)).toBe("6:00–7:00 PM");
  });

  it("prints both periods when the range crosses noon", () => {
    expect(formatTimeRange(11 * 60 + 30, 13 * 60)).toBe("11:30 AM – 1:00 PM");
  });

  it("prints a single time when there is no distinct end", () => {
    expect(formatTimeRange(12 * 60 + 10, null)).toBe("12:10 PM");
    expect(formatTimeRange(9 * 60, 9 * 60)).toBe("9:00 AM");
  });

  it("handles midnight and noon", () => {
    expect(formatTimeRange(0, null)).toBe("12:00 AM");
    expect(formatTimeRange(12 * 60, null)).toBe("12:00 PM");
  });
});

describe("classifyCalendarTitle", () => {
  it.each([
    ["Early Release Day", "early_dismissal"],
    ["Half Day of School", "early_dismissal"],
    ["No School - Teacher Workday", "no_school"],
    ["Thanksgiving Break", "no_school"],
    ["2nd Grade Field Trip", "field_trip"],
    ["Winter Band Concert", "performance"],
    ["Q2 Open Mic", "performance"],
    ["Picture Day", "event"],
    ["Science Fair", "event"],
  ])("%s -> %s", (title, category) => {
    expect(classifyCalendarTitle(title)).toBe(category);
  });
});
