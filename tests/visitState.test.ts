import { describe, expect, it } from "vitest";
import {
  isUnread,
  newSinceLastVisit,
  parseSessionNewIds,
  parseSnapshot,
  snapshotOf,
} from "../src/shared/visitState.js";

const NOW = new Date("2026-11-28T12:00:00Z");

describe("newSinceLastVisit", () => {
  it("flags only the items that were not there at the last visit", () => {
    const previous = snapshotOf(["a", "b", "c"], NOW);
    expect([...newSinceLastVisit(["a", "b", "c", "d", "e"], previous)].sort()).toEqual(["d", "e"]);
  });

  it("flags nothing on a first visit, instead of calling every item new", () => {
    // This was the bug: "42 new items since your last visit" with no last visit.
    expect(newSinceLastVisit(["a", "b", "c"], null).size).toBe(0);
  });

  it("flags nothing when nothing changed, however many items are on the page", () => {
    const ids = Array.from({ length: 50 }, (_unused, index) => `item-${index}`);
    expect(newSinceLastVisit(ids, snapshotOf(ids, NOW)).size).toBe(0);
  });

  it("does not flag an item again once a later visit has seen it", () => {
    const firstVisit = snapshotOf(["a"], NOW);
    const second = newSinceLastVisit(["a", "b"], firstVisit);
    expect([...second]).toEqual(["b"]);
    const afterSecondVisit = snapshotOf(["a", "b"], NOW);
    expect(newSinceLastVisit(["a", "b"], afterSecondVisit).size).toBe(0);
  });

  it("ignores items that were removed since the last visit", () => {
    expect(newSinceLastVisit(["a"], snapshotOf(["a", "gone"], NOW)).size).toBe(0);
  });
});

describe("snapshotOf", () => {
  it("records each id once, with the time", () => {
    expect(snapshotOf(["a", "b", "a"], NOW)).toEqual({ ids: ["a", "b"], at: "2026-11-28T12:00:00.000Z" });
  });
});

describe("parseSnapshot", () => {
  it("round-trips a snapshot", () => {
    const snapshot = snapshotOf(["a", "b"], NOW);
    expect(parseSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it("treats missing or damaged storage as no previous visit", () => {
    for (const raw of [null, undefined, "", "not json", "42", "null", '{"ids":"x","at":"y"}', '{"ids":[]}']) {
      expect(parseSnapshot(raw)).toBeNull();
    }
  });

  it("drops non-string ids rather than failing", () => {
    expect(parseSnapshot('{"ids":["a",1,null,"b"],"at":"2026-11-28T12:00:00.000Z"}')?.ids).toEqual(["a", "b"]);
  });
});

describe("parseSessionNewIds", () => {
  it("restores the ids remembered for this session, including an empty set", () => {
    expect([...(parseSessionNewIds('["a","b"]') ?? [])]).toEqual(["a", "b"]);
    expect(parseSessionNewIds("[]")?.size).toBe(0); // "nothing new" is an answer, not a miss
  });

  it("returns null when nothing usable is stored", () => {
    expect(parseSessionNewIds(null)).toBeNull();
    expect(parseSessionNewIds("oops")).toBeNull();
    expect(parseSessionNewIds('{"a":1}')).toBeNull();
  });
});

describe("isUnread", () => {
  const newIds = new Set(["fresh", "opened"]);
  const opened = new Set(["opened", "old-opened"]);

  it("is unread only when new this visit and not opened", () => {
    expect(isUnread("fresh", newIds, opened)).toBe(true);
    expect(isUnread("opened", newIds, opened)).toBe(false);
  });

  it("is never unread for an item that was already there at the last visit", () => {
    expect(isUnread("old-unopened", newIds, opened)).toBe(false);
    expect(isUnread("old-opened", newIds, opened)).toBe(false);
  });
});
