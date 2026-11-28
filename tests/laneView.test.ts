import { describe, expect, it } from "vitest";
import {
  activeNewsletterWeek,
  CALENDAR_HORIZON_DAYS,
  isWithinCalendarHorizon,
  dateLabelSource,
  isCurrentFeedItem,
  lastDayOf,
  RECENT_WINDOW_DAYS,
  timeSortKey,
} from "../src/shared/laneView.js";

// Fri 2026-11-27: the newsletter for the coming week (11/30-12/4) is already out.
const TODAY = "2026-11-27";
const WEEK = { weekStart: "2026-11-30", weekEnd: "2026-12-04" };

describe("activeNewsletterWeek", () => {
  it("reads the published week, which is usually the coming week", () => {
    expect(activeNewsletterWeek("11/30-12/4", TODAY)).toEqual(WEEK);
  });

  it("accepts an en dash and surrounding spaces", () => {
    expect(activeNewsletterWeek(" 11/30 – 12/4 ", TODAY)).toEqual(WEEK);
  });

  it("rolls the year when the week straddles January", () => {
    expect(activeNewsletterWeek("12/28-1/1", "2026-12-26")).toEqual({
      weekStart: "2026-12-28",
      weekEnd: "2027-01-01",
    });
  });

  it("falls back to the week containing today when there is no usable label", () => {
    const fallback = { weekStart: "2026-11-22", weekEnd: "2026-11-28" };
    expect(activeNewsletterWeek(undefined, TODAY)).toEqual(fallback);
    expect(activeNewsletterWeek("this week", TODAY)).toEqual(fallback);
    expect(activeNewsletterWeek("12/4-11/30", TODAY)).toEqual(fallback); // end before start
  });
});

describe("isCurrentFeedItem — dated items", () => {
  const dated = (date: string) => ({ date, category: "event" });

  it("drops a past calendar event, which is what pushed real ones out of the card", () => {
    expect(isCurrentFeedItem(dated("2026-09-25"), WEEK, TODAY)).toBe(false);
    expect(isCurrentFeedItem(dated("2026-11-23"), WEEK, TODAY)).toBe(false);
  });

  it("keeps today and anything later", () => {
    expect(isCurrentFeedItem(dated(TODAY), WEEK, TODAY)).toBe(true);
    expect(isCurrentFeedItem(dated("2026-12-01"), WEEK, TODAY)).toBe(true);
    expect(isCurrentFeedItem(dated("2026-12-18"), WEEK, TODAY)).toBe(true);
  });
});

describe("isCurrentFeedItem — messages", () => {
  const message = (date: string) => ({ date, category: "announcement" });

  it("drops messages from before the recent window (the September ones)", () => {
    expect(isCurrentFeedItem(message("2026-09-21"), WEEK, TODAY)).toBe(false);
    expect(isCurrentFeedItem(message("2026-10-15"), WEEK, TODAY)).toBe(false);
  });

  it("keeps messages inside the window, measured back from the active week's start", () => {
    // 2026-11-30 minus 28 days is 2026-11-02.
    expect(RECENT_WINDOW_DAYS).toBe(28);
    expect(isCurrentFeedItem(message("2026-11-02"), WEEK, TODAY)).toBe(true);
    expect(isCurrentFeedItem(message("2026-11-01"), WEEK, TODAY)).toBe(false);
    expect(isCurrentFeedItem(message("2026-11-19"), WEEK, TODAY)).toBe(true);
  });

  it("keeps a message from the active week itself", () => {
    expect(isCurrentFeedItem(message("2026-12-02"), WEEK, TODAY)).toBe(true);
  });
});

describe("dateLabelSource", () => {
  it("labels a dated item by its own date, not by its start instant", () => {
    // An all-day event starts at UTC midnight, the previous evening in New York.
    expect(
      dateLabelSource({ date: "2026-12-04", category: "event", received_at: "2026-12-04T00:00:00.000Z" }),
    ).toBe("2026-12-04");
  });

  it("labels a message by when it arrived", () => {
    expect(
      dateLabelSource({ date: "2026-11-19", category: "announcement", received_at: "2026-11-20T01:22:00.000Z" }),
    ).toBe("2026-11-20T01:22:00.000Z");
  });

  it("falls back to the date when a message has no received time", () => {
    expect(dateLabelSource({ date: "2026-11-19", category: "announcement" })).toBe("2026-11-19");
  });
});

describe("timeSortKey", () => {
  it("orders all-day items first, then by start time", () => {
    const labels = ["6:00–7:00 PM", null, "8:45–9:30 AM", "12:10 PM", "11:30 AM – 1:00 PM"];
    expect([...labels].sort((first, second) => timeSortKey(first) - timeSortKey(second))).toEqual([
      null,
      "8:45–9:30 AM",
      "11:30 AM – 1:00 PM",
      "12:10 PM",
      "6:00–7:00 PM",
    ]);
  });

  it("reads the period that is only printed once as applying to the start", () => {
    expect(timeSortKey("6:00–7:00 PM")).toBe(18 * 60);
    expect(timeSortKey("12:00–1:00 PM")).toBe(12 * 60);
    expect(timeSortKey("12:00 AM")).toBe(0);
  });

  it("treats a missing or unreadable time as all-day", () => {
    expect(timeSortKey(null)).toBe(-1);
    expect(timeSortKey("all day")).toBe(-1);
  });
});

describe("multi-day events stay current until their last day", () => {
  it("lastDayOf prefers end_date", () => {
    expect(lastDayOf({ date: "2026-12-21", end_date: "2027-01-04" })).toBe("2027-01-04");
    expect(lastDayOf({ date: "2026-12-21" })).toBe("2026-12-21");
  });

  it("keeps a break that started before today but has not ended", () => {
    const christmasBreak = { date: "2026-12-21", end_date: "2027-01-04", category: "no_school" };
    expect(isCurrentFeedItem(christmasBreak, WEEK, "2026-12-28")).toBe(true);
    expect(isCurrentFeedItem(christmasBreak, WEEK, "2027-01-05")).toBe(false);
  });
});

describe("isWithinCalendarHorizon", () => {
  it("includes the Dec 15 concert from Nov 27 (18 days out) but not a January date", () => {
    expect(CALENDAR_HORIZON_DAYS).toBe(21);
    expect(isWithinCalendarHorizon({ date: "2026-12-15" }, "2026-11-27")).toBe(true);
    expect(isWithinCalendarHorizon({ date: "2026-12-18" }, "2026-11-27")).toBe(true);
    expect(isWithinCalendarHorizon({ date: "2027-01-08" }, "2026-11-27")).toBe(false);
  });

  it("includes something that started earlier and is still running", () => {
    expect(isWithinCalendarHorizon({ date: "2026-11-23" }, "2026-11-27")).toBe(true);
  });
});
