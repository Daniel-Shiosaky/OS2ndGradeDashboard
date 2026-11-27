import { describe, expect, it } from "vitest";
import { resolveSchoolName } from "../src/scripts/generateDashboard.js";

describe("resolveSchoolName", () => {
  it("prefers the name configured in sources.json", () => {
    expect(resolveSchoolName("Oak Street Elementary", "Example Elementary School")).toBe(
      "Oak Street Elementary",
    );
  });

  it("falls back to the previous dataset when the config is unreadable", () => {
    expect(resolveSchoolName(null, "Oak Street Elementary")).toBe("Oak Street Elementary");
  });

  it("falls back to a neutral placeholder when neither is available", () => {
    expect(resolveSchoolName(null, null)).toBe("School");
  });
});
