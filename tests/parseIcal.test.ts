import { describe, expect, it } from "vitest";
import { parseIcal, unescapeIcalText } from "../src/shared/parseIcal.js";

function feed(...eventBodies: string[]): string {
  return ["BEGIN:VCALENDAR", ...eventBodies.map((body) => `BEGIN:VEVENT\n${body}\nEND:VEVENT`), "END:VCALENDAR"].join("\n");
}

describe("unescapeIcalText", () => {
  it("restores newlines, commas, semicolons and backslashes", () => {
    expect(unescapeIcalText("a\\, b\\; c\\nd\\\\e")).toBe("a, b; c\nd\\e");
  });
});

describe("parseIcal", () => {
  it("reads a timed event in a named zone as wall-clock time", () => {
    const [event] = parseIcal(
      feed("UID:1\nDTSTART;TZID=America/New_York:20261215T180000\nDTEND;TZID=America/New_York:20261215T190000\nSUMMARY:Winter Band Concert"),
    );
    expect(event?.summary).toBe("Winter Band Concert");
    expect(event?.start).toEqual({ kind: "local", date: "2026-12-15", time: "18:00", timeZone: "America/New_York" });
    expect(event?.end).toEqual({ kind: "local", date: "2026-12-15", time: "19:00", timeZone: "America/New_York" });
  });

  it("reads an all-day event as a bare date", () => {
    const [event] = parseIcal(feed("UID:1\nDTSTART;VALUE=DATE:20261204\nDTEND;VALUE=DATE:20261205\nSUMMARY:Early Release"));
    expect(event?.start).toEqual({ kind: "date", date: "2026-12-04" });
  });

  it("reads a trailing Z as an absolute instant", () => {
    const [event] = parseIcal(feed("UID:1\nDTSTART:20261209T170000Z\nSUMMARY:Showcase"));
    expect(event?.start.kind).toBe("utc");
    expect(event?.start.kind === "utc" && event.start.instant.toISOString()).toBe("2026-12-09T17:00:00.000Z");
  });

  it("unfolds continuation lines and unescapes text", () => {
    const [event] = parseIcal(
      feed("UID:1\nDTSTART;VALUE=DATE:20261204\nSUMMARY:Open House\nDESCRIPTION:Doors at 5\\, music at 6\n  seating is limited"),
    );
    expect(event?.description).toBe("Doors at 5, music at 6 seating is limited");
  });

  it("flags a recurring event and keeps the status", () => {
    const [event] = parseIcal(feed("UID:1\nDTSTART;VALUE=DATE:20261204\nRRULE:FREQ=WEEKLY\nSTATUS:CANCELLED\nSUMMARY:Club"));
    expect(event?.recurring).toBe(true);
    expect(event?.status).toBe("CANCELLED");
  });

  it("skips an event with no usable start, and tolerates CRLF line endings", () => {
    const events = parseIcal(
      feed("UID:1\nSUMMARY:No start", "UID:2\nDTSTART;VALUE=DATE:20261204\nSUMMARY:Fine").replace(/\n/g, "\r\n"),
    );
    expect(events.map((event) => event.summary)).toEqual(["Fine"]);
  });
});
