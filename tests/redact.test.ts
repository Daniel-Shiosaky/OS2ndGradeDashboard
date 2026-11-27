import { describe, expect, it } from "vitest";
import { mustDropLine } from "../src/shared/redact.js";

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
