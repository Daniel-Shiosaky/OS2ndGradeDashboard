import { describe, expect, it } from "vitest";
import {
  googleDocExportUrl,
  googleDocId,
  parseNewsletterWeekStart,
  resolveMonthDay,
  pickLatestNewsletter,
} from "../src/shared/newsletter.js";

// Real link titles and ids as posted on the 2nd Grade Parent Group board.
const BOARD_LINKS = [
  { title: "9/7-9/11 Second Grade Newsletter", url: "https://docs.google.com/document/d/1NaVA4Cl88vgTzpUVc_gSOmwYa-nkWcbwf522FttqWdQ/edit?usp=sharing" },
  { title: "9/21-9/25 Second Grade Newsletter", url: "https://docs.google.com/document/d/1xKPt0ae8uTWt_8Ifq3vEPpaiVFnrSd9bFjbYpvuEnuY/edit?usp=sharing" },
  { title: "9/14-9/18 Second Grade Newsletter", url: "https://docs.google.com/document/d/1OOi4MRXLNJcgrNn_8sRG38dqZ5YEXqxRbJly2G3tNrA/edit?usp=sharing" },
  { title: "Mrs. Rivera's Meet The Teacher", url: "https://docs.google.com/presentation/d/EXAMPLE_SLIDES_ID/edit?usp=sharing" },
  { title: "Birthday Treats from Storytime Cafe", url: "https://order.toasttab.com/online/story-time-cafe#!/" },
];

const TODAY = new Date("2026-09-22T12:00:00Z");

describe("googleDocId / googleDocExportUrl", () => {
  it("extracts the id from a sharing URL", () => {
    expect(googleDocId(BOARD_LINKS[1]!.url)).toBe("1xKPt0ae8uTWt_8Ifq3vEPpaiVFnrSd9bFjbYpvuEnuY");
  });

  it("builds the no-auth plain-text export URL", () => {
    expect(googleDocExportUrl(BOARD_LINKS[1]!.url)).toBe(
      "https://docs.google.com/document/d/1xKPt0ae8uTWt_8Ifq3vEPpaiVFnrSd9bFjbYpvuEnuY/export?format=txt",
    );
  });

  it("returns null for a Slides link, which is not a doc", () => {
    expect(googleDocId(BOARD_LINKS[3]!.url)).toBeNull();
    expect(googleDocExportUrl(BOARD_LINKS[3]!.url)).toBeNull();
  });
});

describe("parseNewsletterWeekStart", () => {
  it("resolves M/D against the current year", () => {
    expect(parseNewsletterWeekStart("9/21-9/25 Second Grade Newsletter", TODAY)).toBe("2026-09-21");
  });

  it("reads a far-future date as belonging to the previous year", () => {
    // In January, a "12/14" newsletter is last month, not 11 months away.
    expect(parseNewsletterWeekStart("12/14-12/18 Newsletter", new Date("2027-01-05T00:00:00Z"))).toBe(
      "2026-12-14",
    );
  });

  it("rejects titles with no date and impossible dates", () => {
    expect(parseNewsletterWeekStart("Meet The Teacher", TODAY)).toBeNull();
    expect(parseNewsletterWeekStart("2/30-3/1 Newsletter", TODAY)).toBeNull();
    expect(parseNewsletterWeekStart("13/1 Newsletter", TODAY)).toBeNull();
  });
});

describe("pickLatestNewsletter", () => {
  it("picks the newest week regardless of board DOM order", () => {
    const pick = pickLatestNewsletter(BOARD_LINKS, TODAY);
    expect(pick?.weekStart).toBe("2026-09-21");
    expect(pick?.url).toContain("1xKPt0ae8uTWt_8Ifq3vEPpaiVFnrSd9bFjbYpvuEnuY");
  });

  it("ignores non-newsletter links pinned to the same board", () => {
    const pick = pickLatestNewsletter(
      [BOARD_LINKS[3]!, BOARD_LINKS[4]!],
      TODAY,
    );
    expect(pick).toBeNull();
  });

  it("returns null rather than guessing when the board has no newsletters", () => {
    expect(pickLatestNewsletter([], TODAY)).toBeNull();
  });

  it("honours a custom title pattern", () => {
    const pick = pickLatestNewsletter(BOARD_LINKS, TODAY, "Second Grade Newsletter");
    expect(pick?.weekStart).toBe("2026-09-21");
  });
});

describe("resolveMonthDay — a school year straddles January", () => {
  it("reads a date far in the future as last calendar year", () => {
    expect(resolveMonthDay(12, 18, new Date("2027-01-10T12:00:00Z"))).toBe("2026-12-18");
  });

  it("reads a date far in the past as next calendar year (Jan 1 seen on Dec 28)", () => {
    // The old rule only corrected the future direction, so this came out as
    // 2026-01-01 — eleven months ago — and was hidden as a past event.
    expect(resolveMonthDay(1, 1, new Date("2026-12-28T12:00:00Z"))).toBe("2027-01-01");
    expect(resolveMonthDay(1, 8, new Date("2026-12-28T12:00:00Z"))).toBe("2027-01-08");
  });

  it("keeps ordinary nearby dates in the current year, past or future", () => {
    expect(resolveMonthDay(9, 21, new Date("2026-09-22T12:00:00Z"))).toBe("2026-09-21");
    expect(resolveMonthDay(9, 25, new Date("2026-09-22T12:00:00Z"))).toBe("2026-09-25");
    expect(resolveMonthDay(12, 4, new Date("2026-11-27T12:00:00Z"))).toBe("2026-12-04");
  });

  it("still rejects impossible dates", () => {
    expect(resolveMonthDay(2, 30, new Date("2026-02-01T12:00:00Z"))).toBeNull();
  });
});
