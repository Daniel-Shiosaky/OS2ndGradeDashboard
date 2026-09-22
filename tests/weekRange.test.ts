import { describe, expect, it } from "vitest";
import { getCurrentWeekRange, isAfterRange, isWithinRange } from "../src/shared/weekRange.js";

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
