import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateEventsFile } from "../src/scripts/validateData.js";

const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures");

describe("validateEventsFile", () => {
  it("resolves without error for well-formed data", async () => {
    await expect(validateEventsFile(path.join(FIXTURES_DIR, "valid-events.json"))).resolves.toBeUndefined();
  });

  it("rejects malformed data (bad date format, unknown category)", async () => {
    await expect(validateEventsFile(path.join(FIXTURES_DIR, "invalid-schema-events.json"))).rejects.toThrow(
      "Schema validation failed",
    );
  });

  it("rejects duplicate event ids", async () => {
    await expect(validateEventsFile(path.join(FIXTURES_DIR, "duplicate-id-events.json"))).rejects.toThrow(
      "Duplicate event id detected",
    );
  });
});
