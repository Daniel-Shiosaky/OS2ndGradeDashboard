import { describe, expect, it } from "vitest";
import { mentionsAnyName, mustDropLine, redactSourceText, sanitizeExtractedEvents } from "../src/shared/redact.js";
import type { ExtractedEvent } from "../src/types/schema.js";

describe("mustDropLine — phone numbers", () => {
  // Every shape a real school email or newsletter uses. The first version only
  // matched the separated form, so the other shapes were published verbatim.
  it.each([
    "Call the office at 555-123-4567",
    "Call the office at (555) 123-4567",
    "Call the office at (555)123-4567",
    "Call the office at 555.123.4567",
    "Call the office at 555 123 4567",
    "Call the office at 5551234567",
    "Call the office at +1 555 123 4567",
    "Call the office at 1-555-123-4567",
  ])("drops %s", (line) => {
    expect(mustDropLine(line)).toBe(true);
  });

  // Over-dropping costs a line; these are the common near-misses that must not
  // be swallowed, or ordinary newsletter content disappears.
  it.each([
    "Spelling test 9/21-9/25",
    "Backpack Pg. 35-39 Due",
    "Math Homework Pg. 123-124 and 127-128 Due",
    "Conferences on 2026-12-04 at 2:10pm",
    "Room 204, 2nd grade",
    "Bring $20 by 12/4",
  ])("keeps %s", (line) => {
    expect(mustDropLine(line)).toBe(false);
  });
});

describe("mentionsAnyName", () => {
  it("matches a configured name as a whole word, in any case", () => {
    expect(mentionsAnyName("Childname's story is featured", ["Childname"])).toBe(true);
    expect(mentionsAnyName("CHILDNAME won", ["childname"])).toBe(true);
  });

  it("does not match inside a longer word, nor on an empty entry", () => {
    expect(mentionsAnyName("Childnames are private", ["Childname"])).toBe(false);
    expect(mentionsAnyName("anything", ["", "  "])).toBe(false);
  });
});

describe("redactSourceText — what is allowed to reach the AI", () => {
  it("drops credential, phone and child-name lines and keeps the rest", () => {
    const { text, droppedLines } = redactSourceText(
      [
        "Field trip Friday 12/1",
        "Username: first.last@example.org",
        "Call (555) 123-4567",
        "Childname is student of the week",
        "Bring a lunch",
      ].join("\n"),
      ["Childname"],
    );
    expect(text).toBe("Field trip Friday 12/1\nBring a lunch");
    expect(droppedLines).toBe(3);
  });

  it("redacts another family's surname in a kept line", () => {
    const { text } = redactSourceText("Snacks courtesy of the Testfamily family", []);
    expect(text).toBe("Snacks courtesy of a family");
  });
});

describe("sanitizeExtractedEvents — what comes back from the AI", () => {
  const event = (overrides: Partial<ExtractedEvent>): ExtractedEvent => ({
    date: "2026-12-01",
    time: null,
    title: "Field trip",
    category: "field_trip",
    description: "",
    importance: "high",
    uncertain: false,
    ...overrides,
  });

  it("withholds an event that echoes a credential, a phone number or a child's name", () => {
    const { events, withheld } = sanitizeExtractedEvents(
      [
        event({ title: "Login Password: abc123" }),
        event({ description: "Call 555-123-4567 to confirm" }),
        event({ title: "Childname's birthday" }),
        event({ title: "Field trip" }),
      ],
      ["Childname"],
    );
    expect(events.map((kept) => kept.title)).toEqual(["Field trip"]);
    expect(withheld).toBe(3);
  });

  it("redacts a family surname instead of dropping the event", () => {
    const { events } = sanitizeExtractedEvents(
      [event({ title: "Party hosted by the Testfamily family" })],
      [],
    );
    expect(events[0]?.title).toBe("Party hosted by a family");
  });
});
