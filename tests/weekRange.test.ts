import { describe, expect, it } from "vitest";
import {
  getCurrentWeekRange,
  getCurrentWeekRangeInTimeZone,
  isAfterRange,
  isWithinRange,
  todayInTimeZone,
} from "../src/shared/weekRange.js";

describe("getCurrentWeekRange", () => {
  it("returns the Sunday-to-Saturday range containing a mid-week reference date", () => {
    // Wednesday 2026-09-23 (UTC)
    const range = getCurrentWeekRange(new Date("2026-09-23T12:00:00Z"));
    expect(range).toEqual({ weekStart: "2026-09-20", weekEnd: "2026-09-26" });
  });

  it("treats a Sunday reference date as the start of its own week", () => {
    const range = getCurrentWeekRange(new Date("2026-09-20T00:00:00Z"));
    expect(range).toEqual({ weekStart: "2026-09-20", weekEnd: "2026-09-26" });
  });

  it("treats a Saturday reference date as the end of its own week", () => {
    const range = getCurrentWeekRange(new Date("2026-09-26T23:59:59Z"));
    expect(range).toEqual({ weekStart: "2026-09-20", weekEnd: "2026-09-26" });
  });

  it("handles a week that spans a month boundary", () => {
    const range = getCurrentWeekRange(new Date("2026-09-30T00:00:00Z"));
    expect(range).toEqual({ weekStart: "2026-09-27", weekEnd: "2026-10-03" });
  });
});

describe("isWithinRange", () => {
  const range = { weekStart: "2026-09-20", weekEnd: "2026-09-26" };

  it("returns true for dates on the boundary", () => {
    expect(isWithinRange("2026-09-20", range)).toBe(true);
    expect(isWithinRange("2026-09-26", range)).toBe(true);
  });

  it("returns true for a date inside the range", () => {
    expect(isWithinRange("2026-09-23", range)).toBe(true);
  });

  it("returns false for dates outside the range", () => {
    expect(isWithinRange("2026-09-19", range)).toBe(false);
    expect(isWithinRange("2026-09-27", range)).toBe(false);
  });
});

describe("isAfterRange", () => {
  const range = { weekStart: "2026-09-20", weekEnd: "2026-09-26" };

  it("returns false for the last day of the range", () => {
    expect(isAfterRange("2026-09-26", range)).toBe(false);
  });

  it("returns true for a date after the range", () => {
    expect(isAfterRange("2026-09-27", range)).toBe(true);
  });

  it("returns false for a date before or within the range", () => {
    expect(isAfterRange("2026-09-19", range)).toBe(false);
    expect(isAfterRange("2026-09-23", range)).toBe(false);
  });
});

describe("todayInTimeZone", () => {
  it("returns the school's calendar day, not UTC's, late in the evening", () => {
    // 2026-09-22 20:16 EDT is already 2026-09-23 in UTC. The dashboard must
    // still treat it as the 22nd, or that day's events vanish hours early.
    const at = new Date("2026-09-23T00:16:00Z");
    expect(at.toISOString().slice(0, 10)).toBe("2026-09-23"); // the old behaviour
    expect(todayInTimeZone("America/New_York", at)).toBe("2026-09-22");
  });

  it("agrees with UTC when the zone is UTC", () => {
    expect(todayInTimeZone("UTC", new Date("2026-09-23T00:16:00Z"))).toBe("2026-09-23");
  });

  it("falls back to UTC for an unrecognised zone instead of throwing", () => {
    expect(todayInTimeZone("Not/AZone", new Date("2026-09-23T00:16:00Z"))).toBe("2026-09-23");
  });
});

describe("getCurrentWeekRangeInTimeZone", () => {
  it("anchors the week to the school's day across the UTC boundary", () => {
    // Late Saturday evening in New York is already Sunday in UTC, which would
    // otherwise advance the dashboard a whole week early.
    const at = new Date("2026-09-27T01:00:00Z"); // Sat 2026-09-26 21:00 EDT
    expect(getCurrentWeekRangeInTimeZone("America/New_York", at)).toEqual({
      weekStart: "2026-09-20",
      weekEnd: "2026-09-26",
    });
    expect(getCurrentWeekRangeInTimeZone("UTC", at)).toEqual({
      weekStart: "2026-09-27",
      weekEnd: "2026-10-03",
    });
  });
});
