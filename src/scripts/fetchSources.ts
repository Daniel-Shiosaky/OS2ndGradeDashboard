// Step: fetch source content for each configured source. Fails safely
// per-source: one broken source must not abort the whole run.
//
// - website / calendar: unauthenticated Playwright page fetch.
// - pdf: not fetched here (Playwright doesn't parse PDFs).
// - school_portal: Playwright login (Blackbaud/MySchoolApp-style form) then
//   fetch, reusing one authenticated session for every school_portal source.
// - gmail: IMAP with an app password, reusing one connection for every
//   gmail source. Each source is a mailbox search (optionally filtered by
//   sender), not a URL.
//
// ClassDojo is intentionally not supported: its login page returns a 403 to
// headless browsers (bot detection), and defeating that would mean spoofing
// browser fingerprints to evade a service's anti-automation controls, which
// this project won't do. If ClassDojo can email you digests, point a gmail
// source at that instead.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { SourcesConfigSchema, type SourceConfigEntry } from "../types/schema.js";
import { isMainModule } from "./runGuard.js";

const DATA_DIR = path.resolve(import.meta.dirname, "../../data");
const RAW_OUTPUT_DIR = path.resolve(import.meta.dirname, "../../output/raw");
const DEFAULT_GMAIL_LOOKBACK_DAYS = 14;

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

// Resolves url/filterFrom, preferring the *Env indirection (an env var name)
// so a committed sources.json never has to contain an identifying URL or
// email address directly.
function resolveUrl(source: SourceConfigEntry): string {
  if (source.urlEnv) {
    const value = process.env[source.urlEnv];
    if (!value) throw new Error(`Environment variable ${source.urlEnv} (urlEnv) is not set`);
    return value;
  }
  if (!source.url) throw new Error("Source has neither url nor urlEnv set");
  return source.url;
}

function resolveFilterFrom(source: SourceConfigEntry): string | undefined {
  if (source.filterFromEnv) {
    const value = process.env[source.filterFromEnv];
    if (!value) {
      throw new Error(`Environment variable ${source.filterFromEnv} (filterFromEnv) is not set`);
    }
    return value;
  }
  return source.filterFrom;
}

async function fetchOneSource(
  browser: import("playwright").Browser,
  source: SourceConfigEntry,
): Promise<string> {
  const page = await browser.newPage();
  try {
    await page.goto(resolveUrl(source), { waitUntil: "networkidle", timeout: 30_000 });
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    return text.trim();
  } finally {
    await page.close();
  }
}

async function fetchWebsiteSources(sources: SourceConfigEntry[]): Promise<FetchReport> {
  const fetched: FetchedSource[] = [];
  const failures: FetchReport["failures"] = [];
  if (sources.length === 0) return { fetched, failures };

  const browser = await chromium.launch({ headless: true });
  try {
    for (const source of sources) {
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
  return { fetched, failures };
}

// Logs into a Blackbaud/MySchoolApp-style portal (#Username / #Password /
// #loginBtn, with an optional #nextBtn intermediate step) once, then fetches
// each configured school_portal page's body text in the same session.
async function fetchSchoolPortalSources(sources: SourceConfigEntry[]): Promise<FetchReport> {
  const fetched: FetchedSource[] = [];
  const failures: FetchReport["failures"] = [];
  if (sources.length === 0) return { fetched, failures };

  const loginUrl = process.env.SCHOOL_PORTAL_LOGIN_URL;
  const username = process.env.SCHOOL_PORTAL_USERNAME;
  const password = process.env.SCHOOL_PORTAL_PASSWORD;
  if (!loginUrl || !username || !password) {
    const error =
      "SCHOOL_PORTAL_LOGIN_URL / SCHOOL_PORTAL_USERNAME / SCHOOL_PORTAL_PASSWORD not configured";
    for (const source of sources) {
      failures.push({ source, error });
      console.log(`  FAIL ${source.name}: ${error}`);
    }
    return { fetched, failures };
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const loginPage = await context.newPage();
    try {
      await loginPage.goto(loginUrl, { waitUntil: "networkidle", timeout: 30_000 });
      await loginPage.fill("#Username", username);
      await loginPage.fill("#Password", password);

      const loginBtn = loginPage.locator("#loginBtn");
      if (await loginBtn.isVisible().catch(() => false)) {
        await loginBtn.click();
      } else {
        await loginPage.locator("#nextBtn").click();
        await loginPage.waitForTimeout(1000);
        await loginPage.locator("#loginBtn").click();
      }
      await loginPage.waitForLoadState("networkidle", { timeout: 30_000 });
    } finally {
      await loginPage.close();
    }

    for (const source of sources) {
      const page = await context.newPage();
      try {
        await page.goto(resolveUrl(source), { waitUntil: "networkidle", timeout: 30_000 });
        const text = (await page.evaluate(() => document.body?.innerText ?? "")).trim();
        fetched.push({ source, text, fetchedAt: new Date().toISOString() });
        console.log(`  OK   ${source.name}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push({ source, error: message });
        console.log(`  FAIL ${source.name}: ${message}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }

  return { fetched, failures };
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Connects to Gmail via IMAP (app password) once, then runs each gmail
// source as a mailbox search (optionally filtered by sender + lookback
// window) in the same connection.
async function fetchGmailSources(sources: SourceConfigEntry[]): Promise<FetchReport> {
  const fetched: FetchedSource[] = [];
  const failures: FetchReport["failures"] = [];
  if (sources.length === 0) return { fetched, failures };

  const address = process.env.GMAIL_ADDRESS;
  const appPassword = process.env.GMAIL_APP_PASSWORD;
  const host = process.env.GMAIL_IMAP_HOST || "imap.gmail.com";
  if (!address || !appPassword) {
    const error = "GMAIL_ADDRESS / GMAIL_APP_PASSWORD not configured";
    for (const source of sources) {
      failures.push({ source, error });
      console.log(`  FAIL ${source.name}: ${error}`);
    }
    return { fetched, failures };
  }

  const client = new ImapFlow({
    host,
    port: 993,
    secure: true,
    auth: { user: address, pass: appPassword },
    logger: false,
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock("INBOX");
    try {
      for (const source of sources) {
        try {
          const lookbackDays = source.lookbackDays ?? DEFAULT_GMAIL_LOOKBACK_DAYS;
          const since = new Date();
          since.setDate(since.getDate() - lookbackDays);

          const searchCriteria: Record<string, unknown> = { since };
          const filterFrom = resolveFilterFrom(source);
          if (filterFrom) searchCriteria.from = filterFrom;

          const uids = (await client.search(searchCriteria, { uid: true })) || [];
          const messageTexts: string[] = [];
          for (const uid of uids) {
            const message = await client.fetchOne(uid, { source: true }, { uid: true });
            if (!message || !message.source) continue;
            const parsed = await simpleParser(message.source);
            const body = parsed.text ?? (parsed.html ? stripHtml(parsed.html) : "");
            messageTexts.push(
              `Subject: ${parsed.subject ?? "(no subject)"}\nDate: ${parsed.date?.toISOString() ?? "unknown"}\n\n${body}`,
            );
          }

          fetched.push({
            source,
            text: messageTexts.join("\n\n---\n\n"),
            fetchedAt: new Date().toISOString(),
          });
          console.log(`  OK   ${source.name} (${uids.length} email(s))`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push({ source, error: message });
          console.log(`  FAIL ${source.name}: ${message}`);
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return { fetched, failures };
}

export async function fetchAllSources(): Promise<FetchReport> {
  const config = await loadSourcesConfig();
  const enabledSources = config.sources.filter((s) => s.enabled);

  const websiteSources = enabledSources.filter((s) => s.type === "website" || s.type === "calendar");
  const pdfSources = enabledSources.filter((s) => s.type === "pdf");
  const portalSources = enabledSources.filter((s) => s.type === "school_portal");
  const gmailSources = enabledSources.filter((s) => s.type === "gmail");

  console.log(`Fetching sources...`);

  const results = await Promise.all([
    fetchWebsiteSources(websiteSources),
    fetchSchoolPortalSources(portalSources),
    fetchGmailSources(gmailSources),
  ]);

  for (const source of pdfSources) {
    console.log(`  SKIP ${source.name} (PDF sources are not fetched by the browser step)`);
  }

  const fetched = results.flatMap((r) => r.fetched);
  const failures = results.flatMap((r) => r.failures);

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
