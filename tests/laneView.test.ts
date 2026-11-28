import { describe, expect, it } from "vitest";
import {
  activeNewsletterWeek,
  dateLabelSource,
  isCurrentFeedItem,
  RECENT_WINDOW_DAYS,
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
