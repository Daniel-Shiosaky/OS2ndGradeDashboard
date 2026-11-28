import { describe, expect, it } from "vitest";
import {
  activeNewsletterWeek,
  CALENDAR_HORIZON_DAYS,
  CLASSDOJO_APP_LINK,
  detailLinkFor,
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

describe("detailLinkFor — opening ClassDojo in the app on a phone", () => {
  const IPHONE =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  const ANDROID_PHONE =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";
  const ANDROID_TABLET =
    "Mozilla/5.0 (Linux; Android 14; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const IPAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
  const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const dojoItem = { lane: "classdojo", url: "https://home.classdojo.com/#/story" };

  it("sends a ClassDojo item on an iPhone or Android phone to the app link, in the same tab", () => {
    for (const userAgent of [IPHONE, ANDROID_PHONE]) {
      expect(detailLinkFor(dojoItem, userAgent)).toEqual({
        href: CLASSDOJO_APP_LINK,
        label: "Open in the ClassDojo app",
        opensApp: true,
      });
    }
    expect(CLASSDOJO_APP_LINK).toBe("https://www.classdojo.com/ul/home");
  });

  it("keeps the website link on a desktop or tablet, where the app is not the likely target", () => {
    for (const userAgent of [DESKTOP, IPAD, ANDROID_TABLET]) {
      expect(detailLinkFor(dojoItem, userAgent)).toEqual({
        href: "https://home.classdojo.com/#/story",
        label: "Open the original",
        opensApp: false,
      });
    }
  });

  it("never changes the link for another lane's item, even on a phone", () => {
    expect(detailLinkFor({ lane: "calendar", url: "https://school.example.org/cal" }, IPHONE)).toEqual({
      href: "https://school.example.org/cal",
      label: "Open the original",
      opensApp: false,
    });
    expect(detailLinkFor({ lane: "newsletter", url: "https://docs.example.org/doc" }, ANDROID_PHONE)?.opensApp).toBe(false);
  });

  it("returns no link for a non-ClassDojo item with no source URL", () => {
    expect(detailLinkFor({ lane: "email" }, IPHONE)).toBeNull();
    expect(detailLinkFor({}, DESKTOP)).toBeNull();
  });

  it("still gives a ClassDojo item on a phone the app link even with no stored URL", () => {
    expect(detailLinkFor({ lane: "classdojo" }, IPHONE)?.opensApp).toBe(true);
  });
});
