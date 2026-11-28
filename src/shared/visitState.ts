// What counts as "new since your last visit".
//
// The dashboard has no login, so "new" is worked out in the browser. It used to
// mean "not opened yet", which made the count wrong in three ways: a first-time
// visitor saw every item (and every future calendar event) as "new since your last
// visit"; items you had looked at but not clicked stayed "new" on every later
// visit; and the number only ever grew. An item is now new only if it was not
// there at the previous visit — and still shows as unread until it is opened.
//
// Pure functions so they can be tested; app.ts does the storage.

export interface VisitSnapshot {
  /** Every item id that was on the dashboard at the end of the previous visit. */
  ids: string[];
  at: string;
}

/**
 * Ids that appeared since the previous visit. With no previous visit there is
 * nothing to compare against, so nothing is new: a first-time visitor is not told
 * that everything is new "since their last visit".
 */
export function newSinceLastVisit(currentIds: readonly string[], previous: VisitSnapshot | null): Set<string> {
  if (!previous) return new Set();
  const known = new Set(previous.ids);
  return new Set(currentIds.filter((id) => !known.has(id)));
}

export function snapshotOf(currentIds: readonly string[], now: Date): VisitSnapshot {
  return { ids: [...new Set(currentIds)], at: now.toISOString() };
}

/** Reads a stored snapshot defensively: anything unexpected is treated as "no visit". */
export function parseSnapshot(raw: string | null | undefined): VisitSnapshot | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { ids, at } = value as { ids?: unknown; at?: unknown };
    if (!Array.isArray(ids) || typeof at !== "string") return null;
    return { ids: ids.filter((id): id is string => typeof id === "string"), at };
  } catch {
    return null;
  }
}

/** Reads the ids remembered for the current browser session, or null if there are none. */
export function parseSessionNewIds(raw: string | null | undefined): Set<string> | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    return new Set(value.filter((id): id is string => typeof id === "string"));
  } catch {
    return null;
  }
}

/**
 * An item still shows as unread when it is new this visit and has not been opened.
 * Anything that was already there at the last visit is not unread, however long
 * ago it appeared.
 */
export function isUnread(id: string, newIds: ReadonlySet<string>, openedIds: ReadonlySet<string>): boolean {
  return newIds.has(id) && !openedIds.has(id);
}
