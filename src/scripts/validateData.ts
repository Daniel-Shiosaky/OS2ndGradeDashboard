// Step: validate data/events.json against the schema. Exits non-zero on
// failure so the GitHub Actions job fails loudly rather than publishing
// malformed data (see project brief section 24).

import { readFile } from "node:fs/promises";
import path from "node:path";
import { EventsDataSchema } from "../types/schema.js";
import { isMainModule } from "./runGuard.js";

const EVENTS_PATH = path.resolve(import.meta.dirname, "../../data/events.json");

export async function validateEventsFile(filePath = EVENTS_PATH): Promise<void> {
  const raw = await readFile(filePath, "utf-8");
  const json = JSON.parse(raw);
  const result = EventsDataSchema.safeParse(json);

  if (!result.success) {
    console.error("Validation failed:");
    for (const issue of result.error.issues) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    throw new Error("Schema validation failed");
  }

  const ids = new Set<string>();
  for (const event of result.data.events) {
    if (ids.has(event.id)) {
      throw new Error(`Duplicate event id detected: ${event.id}`);
    }
    ids.add(event.id);
  }
}

async function main() {
  console.log("Validating data...");
  await validateEventsFile();
  console.log("  OK   Validation successful");
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
