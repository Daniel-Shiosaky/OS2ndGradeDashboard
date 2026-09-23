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
// - classdojo: Playwright login to the parent app for a session, then the app's
//   own JSON APIs (parentCalendarEvent, storyFeed) over those cookies. An older
//   comment here claimed ClassDojo 403s headless browsers; it does not — the
//   login page answers 200 and renders normally.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { SourcesConfigSchema, type SourceConfigEntry } from "../types/schema.js";
import {
  findNewsletterLinksInText,
  googleDocExportUrl,
  pickLatestNewsletter,
  type BoardLink,
} from "../shared/newsletter.js";
import { classDojoApiPath } from "../shared/parseClassDojo.js";
import { slugify } from "../shared/text.js";
import { isMainModule } from "./runGuard.js";

const DATA_DIR = path.resolve(import.meta.dirname, "../../data");
const RAW_OUTPUT_DIR = path.resolve(import.meta.dirname, "../../output/raw");
const DEFAULT_GMAIL_LOOKBACK_DAYS = 14;

/**
 * Waits for a single-page app to stop changing, then returns its text.
 *
 * `waitUntil: "networkidle"` is useless against the Blackbaud portal: it keeps
 * connections open indefinitely, so the wait always times out. Worse, reading
 * too early returns only the nav shell (~200 chars) instead of the ~10k chars
 * of real content. Polling until the text length holds steady handles both.
 * Navigation mid-poll destroys the execution context, so that is tolerated.
 */
async function settledText(
  page: import("playwright").Page,
  { timeout = 45_000, quietMs = 3_000 } = {},
): Promise<string> {
  const start = Date.now();
  let lastLength = -1;
  let stableSince = Date.now();
  let text = "";

  while (Date.now() - start < timeout) {
    let length: number;
    try {
      text = await page.evaluate(() => (document.body?.innerText ?? "").trim());
      length = text.length;
    } catch {
      await page.waitForTimeout(800); // context destroyed by a redirect; retry
      continue;
    }
    if (length !== lastLength) {
      lastLength = length;
      stableSince = Date.now();
    } else if (length > 200 && Date.now() - stableSince > quietMs) {
      break;
    }
    await page.waitForTimeout(600);
  }
  return text;
}

export interface FetchedSource {
  source: SourceConfigEntry;
  text: string;
  fetchedAt: string;
}

export interface FetchReport {
  fetched: FetchedSource[];
  failures: Array<{ source: SourceConfigEntry; error: string }>;
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

function portalCredentials() {
  const loginUrl = process.env.SCHOOL_PORTAL_LOGIN_URL;
  const username = process.env.SCHOOL_PORTAL_USERNAME;
  const password = process.env.SCHOOL_PORTAL_PASSWORD;
  if (!loginUrl || !username || !password) return null;
  return { loginUrl, username, password };
}

/**
 * Signs into a Blackbaud MySchoolApp portal.
 *
 * The flow is three hops, not one form:
 *   1. MySchoolApp collects only the username (#Username) and submits #nextBtn.
 *   2. That redirects to app.blackbaud.com/signin, where the email arrives
 *      prepopulated; pressing Continue advances it.
 *   3. The password step is an Azure AD B2C form rendered *inside an iframe*
 *      served from id.blackbaud.com. Playwright pierces shadow DOM but never
 *      frame boundaries, so `page.locator("#password")` finds nothing on the
 *      main frame — the field has to be reached through a frameLocator. The
 *      iframe's name is regenerated per load (sky-id-gen__<timestamp>__1), so
 *      it is matched by URL.
 *
 * A first login from an unrecognised device can also demand a 6-digit code
 * emailed to the account, which no unattended run can satisfy. That is why
 * portal-backed sources are marked localOnly and skipped in CI.
 */
async function loginToPortal(
  context: import("playwright").BrowserContext,
  creds: { loginUrl: string; username: string; password: string },
): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto(creds.loginUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForSelector("#Username", { state: "visible", timeout: 30_000 });
    await page.fill("#Username", creds.username);
    await page.click("#nextBtn");

    await page.waitForURL(/app\.blackbaud\.com\/signin/, { timeout: 45_000 });
    const emailBox = page.locator("input[type=email]").first();
    await emailBox.waitFor({ state: "visible", timeout: 30_000 });
    if ((await emailBox.inputValue()) !== creds.username) {
      await emailBox.fill(creds.username);
    }
    await page.getByRole("button", { name: /^continue$/i }).click();

    const idFrame = page.frameLocator('iframe[src*="id.blackbaud.com"]');
    const passwordBox = idFrame.locator("#password");
    await passwordBox.waitFor({ state: "visible", timeout: 60_000 });
    await passwordBox.fill(creds.password);
    await idFrame.getByRole("button", { name: /^sign in$/i }).click();

    await page.waitForURL(/myschoolapp\.com\/app/, { timeout: 120_000 });
    await page.waitForTimeout(8_000); // let the post-login redirect chain settle
  } finally {
    await page.close();
  }
}

/** True when the page bounced back to the portal's login screen. */
function looksLoggedOut(text: string): boolean {
  return /Blackbaud ID \(Email\)/.test(text) || text.trim().length < 150;
}

async function fetchSchoolPortalSources(sources: SourceConfigEntry[]): Promise<FetchReport> {
  const fetched: FetchedSource[] = [];
  const failures: FetchReport["failures"] = [];
  if (sources.length === 0) return { fetched, failures };

  const creds = portalCredentials();
  if (!creds) {
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
    await loginToPortal(context, creds);

    for (const source of sources) {
      const page = await context.newPage();
      try {
        await page.goto(resolveUrl(source), { waitUntil: "domcontentloaded", timeout: 60_000 });
        const text = await settledText(page);
        if (looksLoggedOut(text)) throw new Error("session was not authenticated for this page");
        fetched.push({ source, text, fetchedAt: new Date().toISOString() });
        console.log(`  OK   ${source.name} (${text.length} chars)`);
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

const CLASSDOJO_LOGIN = "https://home.classdojo.com/#/login";

/**
 * Signs into the ClassDojo parent app.
 *
 * Goes straight to the app's own login route rather than clicking through
 * classdojo.com → Log in → Parent. That marketing path is both longer and
 * ambiguous: every "Parent" control there is labelled "Parent sign up", and the
 * form's field ids are regenerated per render (textFieldInputId1, ...3, ...), so
 * only attribute selectors are safe.
 *
 * Contrary to an earlier note in this repo, the app does NOT 403 headless
 * browsers — it answers 200 and renders the parent login form normally.
 */
async function loginToClassDojo(
  context: import("playwright").BrowserContext,
  creds: { email: string; password: string },
): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto(CLASSDOJO_LOGIN, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const email = page.locator('input[name="email"]').first();
    await email.waitFor({ state: "visible", timeout: 45_000 });
    await email.fill(creds.email);
    await page.locator('input[type="password"]').first().fill(creds.password);

    // Keeps the session alive so repeat runs don't re-trigger a device check.
    const keepLoggedIn = page.locator('input[type="checkbox"]').first();
    if (await keepLoggedIn.count()) await keepLoggedIn.check().catch(() => {});

    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL((url) => !url.hash.includes("/login"), { timeout: 90_000 });
    await page.waitForTimeout(5_000);
    await dismissClassDojoModals(page);
  } finally {
    await page.close();
  }
}

/**
 * Closes the upsell/paywall modal ClassDojo shows after login ("No thanks").
 * Wording varies and it does not always appear, so every label is optional and
 * a miss is not an error.
 */
async function dismissClassDojoModals(page: import("playwright").Page): Promise<void> {
  const dismissals = [
    /^no,? thanks$/i,
    /^not now$/i,
    /^maybe later$/i,
    /^skip$/i,
    /^dismiss$/i,
    /^close$/i,
  ];
  for (let pass = 0; pass < 3; pass++) {
    let clicked = false;
    for (const name of dismissals) {
      const button = page.getByRole("button", { name }).first();
      if (await button.count().catch(() => 0)) {
        if (await button.isVisible().catch(() => false)) {
          await button.click().catch(() => {});
          await page.waitForTimeout(1_500);
          clicked = true;
          break;
        }
      }
    }
    // Some variants only offer an aria-labelled close control.
    if (!clicked) {
      const closeButton = page.locator('[aria-label="Close"], [aria-label="close"]').first();
      if ((await closeButton.count().catch(() => 0)) &&
        (await closeButton.isVisible().catch(() => false))) {
        await closeButton.click().catch(() => {});
        await page.waitForTimeout(1_500);
        clicked = true;
      }
    }
    if (!clicked) return;
  }
}

async function fetchClassDojoSources(sources: SourceConfigEntry[]): Promise<FetchReport> {
  const fetched: FetchedSource[] = [];
  const failures: FetchReport["failures"] = [];
  if (sources.length === 0) return { fetched, failures };

  // Falls back to the school-portal login, which is the same account here.
  // Keeping the dedicated names as the first choice means the two can be split
  // later without touching code, and avoids duplicating a password in .env.
  const usingPortalCreds = !process.env.CLASSDOJO_EMAIL || !process.env.CLASSDOJO_PASSWORD;
  const email = process.env.CLASSDOJO_EMAIL || process.env.SCHOOL_PORTAL_USERNAME;
  const password = process.env.CLASSDOJO_PASSWORD || process.env.SCHOOL_PORTAL_PASSWORD;
  if (email && password && usingPortalCreds) {
    console.log("  ..   ClassDojo: using SCHOOL_PORTAL_USERNAME / SCHOOL_PORTAL_PASSWORD");
  }
  if (!email || !password) {
    const error =
      "ClassDojo credentials not configured (set CLASSDOJO_EMAIL / CLASSDOJO_PASSWORD, or SCHOOL_PORTAL_USERNAME / SCHOOL_PORTAL_PASSWORD)";
    for (const source of sources) {
      failures.push({ source, error });
      console.log(`  FAIL ${source.name}: ${error}`);
    }
    return { fetched, failures };
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await loginToClassDojo(context, { email, password });

    // The browser is only needed to obtain a session; the data comes from the
    // app's own JSON APIs, which the authenticated cookies give access to. That
    // avoids waiting on SPA rendering and yields exact dates instead of
    // "15 minutes ago" text.
    for (const source of sources) {
      try {
        const pageUrl = resolveUrl(source);
        const apiUrl = `https://home.classdojo.com${classDojoApiPath(pageUrl)}`;
        const response = await context.request.get(apiUrl, { timeout: 60_000 });
        if (!response.ok()) {
          throw new Error(`${apiUrl} returned ${response.status()}`);
        }
        const text = await response.text();
        const count = (JSON.parse(text) as { _items?: unknown[] })._items?.length ?? 0;
        fetched.push({ source, text, fetchedAt: new Date().toISOString() });
        console.log(`  OK   ${source.name} (${count} item(s) from the API)`);
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

/** Newsletter discovery without the portal: scan what other sources returned. */
async function fetchNewsletterFromDiscoveredLinks(
  sources: SourceConfigEntry[],
  alreadyFetched: FetchedSource[],
): Promise<FetchReport> {
  const fetched: FetchedSource[] = [];
  const failures: FetchReport["failures"] = [];
  const haystack = alreadyFetched.map((item) => item.text).join("\n");
  const links = findNewsletterLinksInText(haystack);

  for (const source of sources) {
    try {
      const pick = pickLatestNewsletter(links, new Date(), "newsletter");
      if (!pick) {
        throw new Error(
          "no newsletter link found in the other sources (portal login unavailable)",
        );
      }
      console.log(`  ..   ${source.name}: found week of ${pick.weekStart} in another source`);
      const text = await fetchGoogleDoc(pick.url);
      fetched.push({
        source: { ...source, url: pick.url, name: `${source.name} (${weekLabelFor(pick)})` },
        text,
        fetchedAt: new Date().toISOString(),
      });
      console.log(`  OK   ${source.name} (${text.length} chars)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ source, error: message });
      console.log(`  FAIL ${source.name}: ${message}`);
    }
  }
  return { fetched, failures };
}

/** Week range from a link's title, e.g. "9/21-9/25"; falls back to the date. */
function weekLabelFor(pick: { title: string; weekStart: string }): string {
  return (
    pick.title.match(/(\d{1,2}\/\d{1,2}\s*[-–—]\s*\d{1,2}\/\d{1,2})/)?.[1]?.trim() ??
    pick.weekStart
  );
}

/**
 * Reads a public Google Doc through its plain-text export endpoint. Link-shared
 * docs need no credentials, so this works on a CI runner with no browser.
 */
async function fetchGoogleDoc(url: string): Promise<string> {
  const exportUrl = googleDocExportUrl(url);
  if (!exportUrl) throw new Error(`not a Google Docs URL: ${url}`);
  const response = await fetch(exportUrl, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Google Doc export returned ${response.status} (is it link-shared?)`);
  }
  // Strip the UTF-8 BOM the export endpoint prepends.
  return (await response.text()).replace(/^﻿/, "").trim();
}

async function fetchGoogleDocSources(sources: SourceConfigEntry[]): Promise<FetchReport> {
  const fetched: FetchedSource[] = [];
  const failures: FetchReport["failures"] = [];

  for (const source of sources) {
    try {
      const url = resolveUrl(source);
      const text = await fetchGoogleDoc(url);
      fetched.push({ source: { ...source, url }, text, fetchedAt: new Date().toISOString() });
      console.log(`  OK   ${source.name} (${text.length} chars)`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ source, error: message });
      console.log(`  FAIL ${source.name}: ${message}`);
    }
  }
  return { fetched, failures };
}

/**
 * The weekly newsletter is a *different* Google Doc every week, linked from the
 * group bulletin board, so the URL cannot be configured once and reused. This
 * logs into the portal purely to discover the newest newsletter link, then
 * reads that doc over plain HTTP. The doc URL becomes the source URL, so the
 * dashboard cites a link parents can actually open.
 */
/**
 * Builds the Newsletter lane. Discovery has two paths, content has one.
 *
 * The doc itself is always read over plain HTTP — it is link-shared. Only finding
 * *which* doc is this week's needs a source:
 *
 *   1. The group bulletin board, via a portal login. Authoritative, has the full
 *      archive, but the login can demand a human (emailed device code).
 *   2. Otherwise, links already present in whatever else was fetched. The
 *      teachers paste the week's doc into their weekly email and repost it to the
 *      ClassDojo story, and those sources run unattended — so this is the path
 *      that lets the lane work in CI.
 */
async function fetchNewsletterBoardSources(
  sources: SourceConfigEntry[],
  alreadyFetched: FetchedSource[],
): Promise<FetchReport> {
  const fetched: FetchedSource[] = [];
  const failures: FetchReport["failures"] = [];
  if (sources.length === 0) return { fetched, failures };

  const creds = portalCredentials();
  if (!creds) {
    return fetchNewsletterFromDiscoveredLinks(sources, alreadyFetched);
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    await loginToPortal(context, creds);

    for (const source of sources) {
      const page = await context.newPage();
      try {
        await page.goto(resolveUrl(source), { waitUntil: "domcontentloaded", timeout: 60_000 });
        const boardText = await settledText(page);
        if (looksLoggedOut(boardText)) {
          throw new Error("bulletin board did not load as an authenticated page");
        }

        const links: BoardLink[] = await page.$$eval("a[href]", (anchors) =>
          anchors.map((anchor) => ({
            title: (anchor.textContent ?? "").trim(),
            url: anchor.getAttribute("href") ?? "",
          })),
        );
        const pick = pickLatestNewsletter(links, new Date(), source.titlePattern);
        if (!pick) {
          throw new Error(
            `no newsletter link matching /${source.titlePattern ?? "newsletter"}/i found on the board`,
          );
        }
        console.log(`  ..   ${source.name}: newest newsletter is week of ${pick.weekStart}`);

        const text = await fetchGoogleDoc(pick.url);
        // Label with just the week range: the link text repeats the source name
        // ("9/21-9/25 Second Grade Newsletter"), which reads badly on a card.
        const weekLabel = weekLabelFor(pick);
        fetched.push({
          // Cite the public doc, not the login-walled board.
          source: { ...source, url: pick.url, name: `${source.name} (${weekLabel})` },
          text,
          fetchedAt: new Date().toISOString(),
        });
        console.log(`  OK   ${source.name} (${text.length} chars)`);
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

/**
 * What we keep about one email.
 *
 * Deliberately NOT stored: the addresses of anyone else on the message. Only
 * derived signals are kept, so other parents' addresses never land on disk or in
 * a committed file. That is the difference between "we redact it later" and "we
 * never had it".
 */
export interface FetchedEmail {
  subject: string;
  date: string | null;
  fromDomain: string;
  body: string;
  /** How many addresses were on To + Cc. */
  recipientCount: number;
  /** List-Unsubscribe / List-Id / List-Post: a mailing-list broadcast. */
  hasListHeaders: boolean;
  /** Precedence: bulk|list, set by mass-mail systems. */
  bulkPrecedence: boolean;
  /** To: undisclosed-recipients, used for blind broadcasts. */
  undisclosedRecipients: boolean;
}

function addressCount(field: unknown): { count: number } {
  const groups = Array.isArray(field) ? field : field ? [field] : [];
  const addresses: string[] = [];
  for (const group of groups as Array<{ value?: Array<{ address?: string }> }>) {
    for (const entry of group.value ?? []) {
      if (entry.address) addresses.push(entry.address.toLowerCase());
    }
  }
  return { count: addresses.length };
}

/** Reduces a parsed email to the signals the broadcast filter needs. */
function describeEmail(
  parsed: import("mailparser").ParsedMail,
  body: string,
): FetchedEmail {
  const header = (name: string) => String(parsed.headers.get(name) ?? "");
  const toField = addressCount(parsed.to);
  const ccField = addressCount(parsed.cc);
  const rawToHeader = header("to").toLowerCase();

  return {
    subject: parsed.subject ?? "(no subject)",
    date: parsed.date?.toISOString() ?? null,
    fromDomain: (parsed.from?.value?.[0]?.address ?? "").split("@")[1]?.toLowerCase() ?? "",
    body,
    recipientCount: toField.count + ccField.count,
    hasListHeaders: Boolean(
      parsed.headers.get("list-unsubscribe") ||
        parsed.headers.get("list-id") ||
        parsed.headers.get("list-post"),
    ),
    bulkPrecedence: /\b(?:bulk|list|junk)\b/i.test(header("precedence")),
    undisclosedRecipients: rawToHeader.includes("undisclosed-recipients"),
  };
}

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

          // IMAP returns UIDs oldest-first. Reverse to newest-first so the most
          // recent mail is what survives any downstream cap.
          const uids = ((await client.search(searchCriteria, { uid: true })) || []).slice().reverse();
          const messages: FetchedEmail[] = [];
          for (const uid of uids) {
            const message = await client.fetchOne(uid, { source: true }, { uid: true });
            if (!message || !message.source) continue;
            const parsed = await simpleParser(message.source);
            const body = parsed.text ?? (parsed.html ? stripHtml(parsed.html) : "");
            messages.push(describeEmail(parsed, body));
          }

          fetched.push({
            source,
            text: JSON.stringify({ messages }, null, 2),
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
  const allEnabled = config.sources.filter((source) => source.enabled);

  // Sources needing an interactive login (new-device email codes, MFA) can't
  // run unattended. Skipping rather than failing keeps the scheduled run green
  // and still publishes whatever the CI-safe sources produced.
  const inCi = Boolean(process.env.CI);
  const skippedForCi = inCi ? allEnabled.filter((source) => source.localOnly) : [];
  const enabledSources = inCi ? allEnabled.filter((source) => !source.localOnly) : allEnabled;

  const websiteSources = enabledSources.filter((source) => source.type === "website" || source.type === "calendar");
  const pdfSources = enabledSources.filter((source) => source.type === "pdf");
  const portalSources = enabledSources.filter((source) => source.type === "school_portal");
  const gmailSources = enabledSources.filter((source) => source.type === "gmail");
  const googleDocSources = enabledSources.filter((source) => source.type === "google_doc");
  const newsletterSources = enabledSources.filter((source) => source.type === "newsletter_board");
  const classDojoSources = enabledSources.filter((source) => source.type === "classdojo");

  // Newsletter discovery can fall back to scanning these, so they run first.
  const results = await Promise.all([
    fetchWebsiteSources(websiteSources),
    fetchSchoolPortalSources(portalSources),
    fetchGmailSources(gmailSources),
    fetchGoogleDocSources(googleDocSources),
    fetchClassDojoSources(classDojoSources),
  ]);
  results.push(
    await fetchNewsletterBoardSources(newsletterSources, results.flatMap((report) => report.fetched)),
  );

  for (const source of pdfSources) {
    console.log(`  SKIP ${source.name} (PDF sources are not fetched by the browser step)`);
  }
  for (const source of skippedForCi) {
    console.log(`  SKIP ${source.name} (localOnly: needs an interactive login, not available in CI)`);
  }

  const fetched = results.flatMap((report) => report.fetched);
  const failures = results.flatMap((report) => report.failures);

  await mkdir(RAW_OUTPUT_DIR, { recursive: true });
  for (const item of fetched) {
    const filePath = path.join(RAW_OUTPUT_DIR, `${slugify(item.source.name)}.json`);
    await writeFile(filePath, JSON.stringify(item, null, 2), "utf-8");
  }

  return { fetched, failures };
}

async function main() {
  // Printed by the orchestrator during a full pipeline run; repeated here so the
  // standalone `npm run fetch-sources` output still has its header.
  console.log("Fetching sources...");
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
