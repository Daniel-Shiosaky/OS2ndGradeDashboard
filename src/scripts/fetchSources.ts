// Step: fetch source content using Playwright (renders JS-heavy school
// websites/calendars the way a real browser would, then extracts text).
// Fails safely per-source: one broken source must not abort the whole run.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { SourcesConfigSchema, type SourceConfigEntry } from "../types/schema.js";
import { isMainModule } from "./runGuard.js";

const DATA_DIR = path.resolve(import.meta.dirname, "../../data");
const RAW_OUTPUT_DIR = path.resolve(import.meta.dirname, "../../output/raw");

export interface FetchedSource {
  source: SourceConfigEntry;
  text: string;
  fetchedAt: string;
}

export interface FetchReport {
  fetched: FetchedSource[];
  failures: Array<{ source: SourceConfigEntry; error: string }>;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function loadSourcesConfig() {
  const raw = await readFile(path.join(DATA_DIR, "sources.json"), "utf-8");
  return SourcesConfigSchema.parse(JSON.parse(raw));
}

async function fetchOneSource(
  browser: import("playwright").Browser,
  source: SourceConfigEntry,
): Promise<string> {
  const page = await browser.newPage();
  try {
    await page.goto(source.url, { waitUntil: "networkidle", timeout: 30_000 });
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    return text.trim();
  } finally {
    await page.close();
  }
}

export async function fetchAllSources(): Promise<FetchReport> {
  const config = await loadSourcesConfig();
  const enabledSources = config.sources.filter((s) => s.enabled && s.type !== "pdf");

  console.log(`Fetching sources...`);

  const browser = await chromium.launch({ headless: true });
  const fetched: FetchedSource[] = [];
  const failures: FetchReport["failures"] = [];

  try {
    for (const source of enabledSources) {
      try {
        const text = await fetchOneSource(browser, source);
        fetched.push({ source, text, fetchedAt: new Date().toISOString() });
        console.log(`  OK   ${source.name}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ source, error: message });
        console.log(`  FAIL ${source.name}: ${message}`);
      }
    }
  } finally {
    await browser.close();
  }

  const skippedPdfSources = config.sources.filter((s) => s.enabled && s.type === "pdf");
  for (const source of skippedPdfSources) {
    console.log(`  SKIP ${source.name} (PDF sources are not fetched by the browser step)`);
  }

  await mkdir(RAW_OUTPUT_DIR, { recursive: true });
  for (const item of fetched) {
    const filePath = path.join(RAW_OUTPUT_DIR, `${slugify(item.source.name)}.json`);
    await writeFile(filePath, JSON.stringify(item, null, 2), "utf-8");
  }

  return { fetched, failures };
}

async function main() {
  const report = await fetchAllSources();
  console.log(`Fetched ${report.fetched.length} source(s), ${report.failures.length} failure(s).`);

  if (report.fetched.length === 0 && report.failures.length > 0) {
    console.error("All sources failed to fetch. Preserving existing data; nothing new to process.");
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
