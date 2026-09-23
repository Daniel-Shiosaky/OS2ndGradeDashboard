// Helpers for the weekly-newsletter source. Kept pure and free of Node/browser
// APIs so they can be unit tested without a portal login or a network call.
//
// The school posts one Google Doc per week on the group bulletin board, titled
// with its week range, e.g. "9/21-9/25 Second Grade Newsletter". The docs are
// shared publicly, so only *finding* the newest link needs an authenticated
// session — reading it does not.

export interface BoardLink {
  title: string;
  url: string;
}

export interface NewsletterPick extends BoardLink {
  /** Start of the week the title refers to, as YYYY-MM-DD. */
  weekStart: string;
}

/** Extracts the document id from any Google Docs URL shape. */
export function googleDocId(url: string): string | null {
  return url.match(/\/document\/d\/([A-Za-z0-9_-]+)/)?.[1] ?? null;
}

/**
 * Plain-text export URL for a Google Doc. This endpoint returns the document
 * body with no authentication when the doc is link-shared, which is why this
 * source needs neither a browser nor credentials.
 */
export function googleDocExportUrl(url: string): string | null {
  const id = googleDocId(url);
  return id ? `https://docs.google.com/document/d/${id}/export?format=txt` : null;
}

/**
 * Resolves the leading `M/D` of a newsletter title to a full date. Titles carry
 * no year, and a school year straddles January, so a date that would land far
 * in the future is read as belonging to the previous calendar year.
 */
export function parseNewsletterWeekStart(title: string, today: Date): string | null {
  const match = title.match(/(\d{1,2})\/(\d{1,2})/);
  if (!match) return null;
  return resolveMonthDay(Number(match[1]), Number(match[2]), today);
}

/**
 * Turns a bare `M/D` into YYYY-MM-DD. The newsletters never print a year, and a
 * school year straddles January, so a date that would land far in the future is
 * read as belonging to the previous calendar year.
 */
export function resolveMonthDay(month: number, day: number, today: Date): string | null {
  if (!Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  let year = today.getUTCFullYear();
  let date = new Date(Date.UTC(year, month - 1, day));
  const sixMonthsMs = 182 * 24 * 60 * 60 * 1000;
  if (date.getTime() - today.getTime() > sixMonthsMs) {
    year -= 1;
    date = new Date(Date.UTC(year, month - 1, day));
  }
  // Guard against e.g. 2/30 silently rolling into March.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

/**
 * Finds newsletter links inside arbitrary fetched text.
 *
 * The teachers put the week's doc link in their weekly email, and it is reposted
 * to the ClassDojo story. Both of those sources work unattended, so scanning
 * them means the Newsletter lane can be built in CI without the portal login
 * that requires a human. The text preceding each link becomes its title, which
 * is where the week range lives ("9/21-9/25 2nd Grade Newsletter").
 */
export function findNewsletterLinksInText(text: string): BoardLink[] {
  const links: BoardLink[] = [];
  const pattern = /https?:\/\/docs\.google\.com\/document\/d\/[A-Za-z0-9_-]{20,}[^\s"'\\)]*/g;
  for (const match of text.matchAll(pattern)) {
    const start = Math.max(0, (match.index ?? 0) - 160);
    // JSON-escaped newlines survive in the raw payloads; treat them as breaks.
    const context = text.slice(start, match.index).replace(/\\+n|\\+r/g, " ");
    links.push({ title: context, url: match[0] });
  }
  return links;
}

/**
 * Picks the most recent newsletter from the links scraped off the bulletin
 * board. Board DOM order is not trusted — the week in the title decides.
 */
export function pickLatestNewsletter(
  links: BoardLink[],
  today: Date,
  titlePattern = "newsletter",
): NewsletterPick | null {
  const re = new RegExp(titlePattern, "i");
  const candidates: NewsletterPick[] = [];

  for (const link of links) {
    if (!re.test(link.title)) continue;
    if (!googleDocId(link.url)) continue;
    const weekStart = parseNewsletterWeekStart(link.title, today);
    if (!weekStart) continue;
    candidates.push({ ...link, weekStart });
  }

  if (candidates.length === 0) return null;
  candidates.sort((first, second) => second.weekStart.localeCompare(first.weekStart));
  return candidates[0]!;
}
