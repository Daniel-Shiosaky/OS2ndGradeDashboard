import { describe, expect, it } from "vitest";
import { capSourceText } from "../src/scripts/processWithAi.js";

describe("capSourceText", () => {
  it("passes text through untouched when it fits", () => {
    const logs: string[] = [];
    expect(capSourceText("short", 100, "Teacher Emails", (m) => logs.push(m))).toBe("short");
    expect(logs).toEqual([]);
  });

  it("truncates and reports the loss rather than dropping content silently", () => {
    const logs: string[] = [];
    const text = "x".repeat(150);
    expect(capSourceText(text, 100, "Teacher Emails", (m) => logs.push(m))).toHaveLength(100);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("Teacher Emails");
    expect(logs[0]).toContain("50 chars not sent");
  });

  it("keeps the leading text, which fetchSources orders newest-first", () => {
    const text = `${"newest".padEnd(50, ".")}${"oldest".padEnd(50, ".")}`;
    expect(capSourceText(text, 50, "Teacher Emails", () => {})).toContain("newest");
  });
});
