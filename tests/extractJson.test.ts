import { describe, expect, it } from "vitest";
import { extractJson } from "../src/scripts/processWithAi.js";
import { ExtractionResultSchema } from "../src/types/schema.js";

describe("extractJson", () => {
  it("parses a plain JSON response", () => {
    expect(extractJson('{"events": [], "conflicts": []}')).toEqual({ events: [], conflicts: [] });
  });

  it("strips a ```json fenced code block", () => {
    const raw = '```json\n{"events": [], "conflicts": []}\n```';
    expect(extractJson(raw)).toEqual({ events: [], conflicts: [] });
  });

  it("strips a fenced code block without a language tag", () => {
    const raw = '```\n{"events": [], "conflicts": []}\n```';
    expect(extractJson(raw)).toEqual({ events: [], conflicts: [] });
  });

  it("throws on non-JSON content", () => {
    expect(() => extractJson("Sure, here are the events you asked for.")).toThrow();
  });
});

describe("ExtractionResultSchema", () => {
  it("accepts a well-formed extraction result", () => {
    const result = ExtractionResultSchema.safeParse({
      events: [
        {
          date: "2026-09-24",
          time: null,
          title: "Science Quiz",
          category: "quiz",
          description: "Chapter 3 quiz.",
          importance: "high",
          uncertain: false,
        },
      ],
      conflicts: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an event missing a required field", () => {
    const result = ExtractionResultSchema.safeParse({
      events: [{ date: "2026-09-24", category: "quiz" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown category", () => {
    const result = ExtractionResultSchema.safeParse({
      events: [{ date: "2026-09-24", title: "Mystery Event", category: "made_up_category" }],
    });
    expect(result.success).toBe(false);
  });
});
