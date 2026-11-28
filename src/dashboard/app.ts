// Concept B — "Three Lanes" dashboard frontend.
//
// One lane per source (Newsletter / ClassDojo / Email) so parents always know
// where to look. Reads data/events.json client-side; there is no backend.
//
// This dashboard is shared by both 2nd-grade classes, so nothing here renders a
// teacher, family, parent or student name, and there is no per-class or
// per-child filter. Senders are shown by role.

import {
  activeNewsletterWeek,
  dateLabelSource,
  detailLinkFor,
  isCurrentFeedItem,
  isWithinCalendarHorizon,
  lastDayOf,
  timeSortKey,
} from "../shared/laneView.js";
import { todayInTimeZone } from "../shared/weekRange.js";
import {
  isUnread,
  newSinceLastVisit,
  parseSessionNewIds,
  parseSnapshot,
  snapshotOf,
} from "../shared/visitState.js";
import {
  LANES,
  type Category,
  type EventsData,
  type Lane,
  type NewsletterDigest,
  type SchoolEvent,
} from "../types/schema.js";

const LANE_LABELS: Record<Lane, string> = {
  newsletter: "Newsletter",
  classdojo: "ClassDojo",
  email: "Email",
  calendar: "Calendar",
};

const CATEGORY_LABELS: Partial<Record<Category, string>> = {
  performance: "Performance",
  early_dismissal: "Early dismissal",
  no_school: "No school",
  holiday: "Holiday",
  field_trip: "Field trip",
  event: "Event",
};

const categoryLabel = (event: SchoolEvent): string | undefined => CATEGORY_LABELS[event.category];

/** A titled block of rows within a lane. */
interface LaneGroup {
  title: string;
  match: (event: SchoolEvent) => boolean;
  sort: (first: SchoolEvent, second: SchoolEvent) => number;
}

const byDateAsc = (first: SchoolEvent, second: SchoolEvent) => first.date.localeCompare(second.date);
const byDateDesc = (first: SchoolEvent, second: SchoolEvent) => second.date.localeCompare(first.date);
/** The Calendar lane: by day, and within a day by start time (all-day first). */
const byDateThenTime = (first: SchoolEvent, second: SchoolEvent) =>
  first.date.localeCompare(second.date) ||
  timeSortKey(first.time) - timeSortKey(second.time) ||
  first.title.localeCompare(second.title);
const byReceivedDesc = (first: SchoolEvent, second: SchoolEvent) =>
  receivedTime(second) - receivedTime(first);

const inCategories =
  (...categories: string[]) =>
  (event: SchoolEvent) =>
    categories.includes(event.category);

/** Sub-headings for the Newsletter lane, in display order. */
const NEWSLETTER_GROUPS: LaneGroup[] = [
  { title: "Tests", match: inCategories("test", "quiz"), sort: byDateAsc },
  { title: "Homework", match: inCategories("homework", "project"), sort: byDateAsc },
  { title: "To do", match: inCategories("supplies", "deadline"), sort: byDateAsc },
  {
    title: "Events",
    match: inCategories(
      "event",
      "field_trip",
      "holiday",
      "no_school",
      "early_dismissal",
      "announcement",
      "other",
    ),
    sort: byDateAsc,
  },
];

/**
 * The ClassDojo and Email lanes carry two different kinds of thing: dated items
 * from a calendar, and written posts or messages. Splitting them means a parent
 * scanning for "what is coming up" is not reading through chat.
 *
 * Dated items sort soonest-first because they are forward-looking; messages sort
 * newest-first, as the brief specifies for these lanes.
 */
function feedGroups(todayIso: string): LaneGroup[] {
  const isDated = (event: SchoolEvent) => event.category !== "announcement";
  return [
    { title: "Upcoming", match: (event) => isDated(event) && event.date >= todayIso, sort: byDateAsc },
    { title: "Messages", match: (event) => event.category === "announcement", sort: byReceivedDesc },
    // Only reachable in "Open all": the dashboard cards drop past dated items.
    { title: "Earlier", match: (event) => isDated(event) && event.date < todayIso, sort: byDateDesc },
  ];
}

/**
 * Groups built from the section names the pipeline published for this lane, so
 * renaming a section in data/sources.json needs no frontend change.
 */
function sectionGroups(
  sectionTitles: string[],
  sort: (first: SchoolEvent, second: SchoolEvent) => number = byReceivedDesc,
): LaneGroup[] {
  return [
    ...sectionTitles.map((title) => ({
      title,
      match: (event: SchoolEvent) => event.source.section === title,
      sort,
    })),
    {
      title: "Other",
      match: (event: SchoolEvent) =>
        !event.source.section || !sectionTitles.includes(event.source.section),
      sort,
    },
  ];
}

function groupsForLane(
  lane: Lane,
  laneSections: EventsData["lane_sections"],
  todayIso: string,
): LaneGroup[] {
  if (lane === "newsletter") return NEWSLETTER_GROUPS;
  const sectionTitles = laneSections?.[lane] ?? [];
  // The calendar is forward-looking, so its sections list soonest first.
  if (lane === "calendar") return sectionGroups(sectionTitles, byDateThenTime);
  return sectionTitles.length > 0 ? sectionGroups(sectionTitles) : feedGroups(todayIso);
}

/** Rows shown per lane on the dashboard; the rest sit behind "Open all". */
const ROWS_PER_LANE = 8;

const READ_STORAGE_KEY = "os2g.readItems.v1";
/** localStorage: the ids on the dashboard at the end of the previous visit. */
const VISIT_STORAGE_KEY = "os2g.visit.v2";
/** sessionStorage: which ids were new at the start of THIS visit, so a reload keeps the answer. */
const SESSION_STORAGE_KEY = "os2g.sessionNew.v2";

function $(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

/* ---------- read state (per browser, no login) ---------- */

/**
 * There is no account system, so "new" is tracked per browser in localStorage.
 * Each parent's device keeps its own read state. Storage can throw in private
 * modes, so every access is guarded — a browser that refuses storage simply
 * shows everything as unread rather than breaking the page.
 */
function loadReadIds(): Set<string> {
  try {
    const raw = localStorage.getItem(READ_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((entry) => typeof entry === "string")) : new Set();
  } catch {
    return new Set();
  }
}

/**
 * The ids that are new this visit: on the dashboard now, but not at the last visit.
 *
 * Worked out once per browser session. A reload (or coming back to the tab) keeps
 * the same answer instead of treating everything as already seen; the snapshot
 * only rolls forward when a new session starts. Storage can throw in private
 * modes, in which case nothing is flagged new rather than everything.
 */
function resolveNewIds(currentIds: string[]): Set<string> {
  try {
    const remembered = parseSessionNewIds(sessionStorage.getItem(SESSION_STORAGE_KEY));
    if (remembered) return remembered;
  } catch {
    /* fall through and compute it */
  }
  let previous = null;
  try {
    previous = parseSnapshot(localStorage.getItem(VISIT_STORAGE_KEY));
  } catch {
    /* no previous visit */
  }
  const newIds = newSinceLastVisit(currentIds, previous);
  try {
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify([...newIds]));
    localStorage.setItem(VISIT_STORAGE_KEY, JSON.stringify(snapshotOf(currentIds, new Date())));
  } catch {
    /* private mode or storage full: counts just won't carry to the next visit */
  }
  return newIds;
}

function saveReadIds(ids: Set<string>): void {
  try {
    localStorage.setItem(READ_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    /* private mode or storage full: read state just won't persist */
  }
}

/* ---------- formatting ---------- */

function formatDay(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return dateStr;
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * A received instant is shown in the school's zone: a 9:22pm Eastern post is already
 * the next day in UTC, which disagreed with the date the backend computed. A bare
 * calendar date has no zone, so it stays on UTC to avoid shifting it a day.
 */
/** "Mon, Dec 7", or "Mon, Dec 7 – Thu, Dec 10" for a multi-day event. */
function formatDayRange(event: SchoolEvent): string {
  return event.end_date && event.end_date !== event.date
    ? `${formatDay(event.date)} – ${formatDay(event.end_date)}`
    : formatDay(event.date);
}

function formatReceived(event: SchoolEvent, timeZone: string): string {
  const raw = dateLabelSource(event);
  const isBareDate = raw.length <= 10;
  const date = new Date(isBareDate ? `${raw}T00:00:00Z` : raw);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: isBareDate ? "UTC" : timeZone,
  });
}

function receivedTime(event: SchoolEvent): number {
  const raw = event.received_at ?? `${event.date}T00:00:00Z`;
  const time = new Date(raw.length <= 10 ? `${raw}T00:00:00Z` : raw).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/* ---------- rows ---------- */

interface RowContext {
  timeZone: string;
  isRead: (event: SchoolEvent) => boolean;
  open: (event: SchoolEvent) => void;
}

function eventRow(event: SchoolEvent, ctx: RowContext): HTMLElement {
  const unread = !ctx.isRead(event);

  const row = document.createElement("button");
  row.type = "button";
  row.className = unread ? "row row--unread" : "row";
  row.addEventListener("click", () => ctx.open(event));

  const dot = document.createElement("span");
  dot.className = "row__dot";
  dot.setAttribute("aria-hidden", "true");
  row.appendChild(dot);

  const main = document.createElement("span");

  const title = document.createElement("p");
  title.className = "row__title";
  title.textContent = event.title;
  main.appendChild(title);

  const meta = document.createElement("p");
  meta.className = "row__meta";

  // Unread is conveyed in text too, not by the dot's colour alone.
  if (unread) {
    const state = document.createElement("span");
    state.className = "visually-hidden";
    state.textContent = "unread";
    meta.appendChild(state);
  }

  const parts: string[] = [];
  if (event.source.lane === "newsletter") {
    // The lane header already names the source, so show the day instead.
    parts.push(formatDay(event.date));
  } else if (event.source.lane === "calendar") {
    // A calendar item is about WHEN it happens, not when it was posted.
    parts.push(formatDayRange(event));
    if (event.time) parts.push(event.time);
    const label = categoryLabel(event);
    if (label) parts.push(label);
  } else {
    if (event.source.role) parts.push(event.source.role);
    parts.push(formatReceived(event, ctx.timeZone));
  }
  const detail = document.createElement("span");
  detail.textContent = parts.join(" · ");
  meta.appendChild(detail);

  if (event.whole_school) {
    const tag = document.createElement("span");
    tag.className = "row__tag";
    tag.textContent = "Whole school";
    meta.appendChild(tag);
  }
  if (event.importance === "high") {
    const tag = document.createElement("span");
    tag.className = "row__tag row__tag--flag";
    tag.textContent = "Important";
    meta.appendChild(tag);
  }
  if (event.uncertain) {
    const tag = document.createElement("span");
    tag.className = "row__tag";
    tag.textContent = "Unconfirmed";
    meta.appendChild(tag);
  }

  main.appendChild(meta);
  row.appendChild(main);
  return row;
}

function emptyNote(container: HTMLElement, message: string): void {
  const note = document.createElement("p");
  note.className = "lane__empty";
  note.textContent = message;
  container.appendChild(note);
}

/* ---------- app ---------- */

function init(data: EventsData): void {
  const timeZone = data.timezone || "UTC";
  const todayIsoDate = todayInTimeZone(timeZone);
  const readIds = loadReadIds();
  const newIds = resolveNewIds(data.events.map((event) => event.id));

  $("#class-name").textContent = data.school_name;
  document.title = data.school_name;

  // The cards follow the active newsletter week, which is usually the coming
  // week rather than the one containing today. "Open all" keeps the full history.
  const activeWeek = activeNewsletterWeek(data.newsletter?.week_label, todayIsoDate);
  // A multi-day event stays current until its last day.
  const upcoming = data.events.filter((event) => lastDayOf(event) >= todayIsoDate);

  /** Dashboard cards: the Newsletter lane's coming items, current items elsewhere. */
  const byLane = new Map<Lane, SchoolEvent[]>();
  /** "Open all": the same lanes without the recency filter on the feed lanes. */
  const byLaneAll = new Map<Lane, SchoolEvent[]>();
  for (const lane of LANES) {
    byLane.set(lane, []);
    byLaneAll.set(lane, []);
  }
  for (const event of data.events) {
    const lane = event.source.lane ?? "newsletter";
    if (lane === "newsletter" || lane === "calendar") {
      if (!upcoming.includes(event)) continue;
      byLaneAll.get(lane)?.push(event);
      // The Calendar card looks a few weeks ahead; the rest is under "Open all".
      if (lane === "calendar" && !isWithinCalendarHorizon(event, todayIsoDate)) continue;
      byLane.get(lane)?.push(event);
      continue;
    }
    byLaneAll.get(lane)?.push(event);
    if (isCurrentFeedItem(event, activeWeek, todayIsoDate)) byLane.get(lane)?.push(event);
  }
  for (const lanes of [byLane, byLaneAll]) {
    for (const lane of LANES) {
      const items = lanes.get(lane)!;
      if (lane === "newsletter") items.sort((first, second) => first.date.localeCompare(second.date));
      else if (lane === "calendar") items.sort(byDateThenTime);
      else items.sort((first, second) => receivedTime(second) - receivedTime(first));
    }
  }

  // "Unread" means new since the last visit and not opened yet. Anything that was
  // already on the dashboard at the last visit is not unread, however long ago it appeared.
  const isRead = (event: SchoolEvent) => !isUnread(event.id, newIds, readIds);
  const unreadCount = (lane: Lane) => byLane.get(lane)!.filter((event) => !isRead(event)).length;

  const detailDialog = $("#detail-dialog") as HTMLDialogElement;
  const listDialog = $("#list-dialog") as HTMLDialogElement;

  function markRead(event: SchoolEvent): void {
    if (readIds.has(event.id)) return;
    readIds.add(event.id);
    saveReadIds(readIds);
  }

  function openDetail(event: SchoolEvent): void {
    $("#detail-kicker").textContent = LANE_LABELS[event.source.lane ?? "newsletter"];
    $("#detail-title").textContent = event.title;

    const meta: string[] = [formatDayRange(event)];
    if (event.time) meta.push(event.time);
    if (event.source.lane === "calendar") {
      const label = categoryLabel(event);
      if (label) meta.push(label);
    }
    if (event.source.role) meta.push(event.source.role);
    if (event.whole_school) meta.push("Whole school");
    $("#detail-meta").textContent = meta.join(" · ");

    const body = $("#detail-body");
    body.innerHTML = "";
    const text = document.createElement("p");
    text.textContent = event.description || "No further detail was given in the source.";
    body.appendChild(text);

    const link = $("#detail-link") as HTMLAnchorElement;
    const detailLink = detailLinkFor(event.source, navigator.userAgent);
    if (detailLink) {
      link.href = detailLink.href;
      link.textContent = detailLink.label;
      // The app link stays in this tab: a new tab can stop iOS handing it to the app.
      link.target = detailLink.opensApp ? "_self" : "_blank";
      link.hidden = false;
    } else {
      link.hidden = true;
    }

    markRead(event);
    detailDialog.showModal();
    render();
  }

  const rowCtx: RowContext = { timeZone, isRead, open: openDetail };

  /** Lane currently shown in the "Open all" dialog, so it can be re-rendered. */
  let listLane: Lane | null = null;

  function renderLaneList(): void {
    if (!listLane) return;
    $("#list-title").textContent = `All ${LANE_LABELS[listLane]} items`;
    const body = $("#list-body");
    body.innerHTML = "";
    const items = byLaneAll.get(listLane)!;
    if (items.length === 0) {
      emptyNote(body, "Nothing here yet.");
      return;
    }
    // Same sections as the lane, but uncapped and including older items.
    renderGrouped(body, items, groupsForLane(listLane, data.lane_sections, todayIsoDate), null);
  }

  function openLaneList(lane: Lane): void {
    listLane = lane;
    renderLaneList();
    listDialog.showModal();
  }

  /**
   * Renders a lane's rows under their group headings.
   *
   * `cap` limits the rows shown on the dashboard, but each non-empty group is
   * guaranteed a couple of rows first: a naive running total would let a busy
   * "Upcoming" block consume the whole budget and hide the Messages heading
   * entirely, making it look as though there were no messages at all.
   */
  function renderGrouped(
    container: HTMLElement,
    items: SchoolEvent[],
    groups: LaneGroup[],
    cap: number | null,
  ): void {
    const populated = groups
      .map((group) => ({ group, rows: items.filter(group.match).sort(group.sort) }))
      .filter(({ rows }) => rows.length > 0);

    const budgets = new Map<string, number>(populated.map(({ group }) => [group.title, 0]));
    if (cap === null) {
      for (const { group, rows } of populated) budgets.set(group.title, rows.length);
    } else {
      // Deal rows out one per section in rotation. Filling sections in order
      // instead let a busy one take almost the whole budget: Teachers took 6 of
      // 8 and the school's own newsletter never appeared under General
      // announcements at all.
      let remaining = cap;
      let dealt = true;
      while (remaining > 0 && dealt) {
        dealt = false;
        for (const { group, rows } of populated) {
          if (remaining <= 0) break;
          const current = budgets.get(group.title) ?? 0;
          if (current < rows.length) {
            budgets.set(group.title, current + 1);
            remaining--;
            dealt = true;
          }
        }
      }
    }

    for (const { group, rows } of populated) {
      const take = budgets.get(group.title) ?? 0;
      if (take === 0) continue;
      const heading = document.createElement("p");
      heading.className = "lane__group-title";
      heading.textContent = group.title;
      container.appendChild(heading);
      for (const event of rows.slice(0, take)) {
        container.appendChild(eventRow(event, rowCtx));
      }
    }
  }

  /**
   * Fills a lane's header description. The Newsletter lane's description ends in
   * "the Google Doc", which is the link to that week's document — the phrase
   * already names the source, so linking it there avoids a second, redundant
   * link in the lane footer.
   */
  function renderLaneDescription(
    element: HTMLElement,
    lane: Lane,
    newsletter: NewsletterDigest | undefined,
  ): void {
    element.textContent = "";

    if (lane === "calendar") {
      element.textContent = "Concerts, early releases and other special school events";
      return;
    }

    if (lane !== "newsletter") {
      // Both feed lanes are split into Upcoming (soonest first) and Messages
      // (newest first), so "newest first" alone would misdescribe them.
      element.textContent =
        lane === "classdojo"
          ? "Upcoming events and class messages"
          : "Upcoming events and school messages";
      return;
    }

    const prefix = newsletter?.week_label ? `Week of ${newsletter.week_label} · from ` : "From ";
    element.append(document.createTextNode(prefix));

    const url = newsletter?.source.url;
    if (!url) {
      element.append(document.createTextNode("the weekly Google Doc"));
      return;
    }
    const link = document.createElement("a");
    link.className = "lane__doc-link";
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "the Google Doc";
    element.append(link);
  }

  function render(): void {
    for (const lane of LANES) {
      const items = byLane.get(lane)!;
      const unread = unreadCount(lane);

      const description = document.querySelector<HTMLElement>(`[data-description="${lane}"]`)!;
      renderLaneDescription(description, lane, data.newsletter);

      const badge = document.querySelector<HTMLElement>(`[data-badge="${lane}"]`)!;
      badge.textContent = `${unread} new`;
      badge.hidden = unread === 0;

      const count = document.querySelector<HTMLElement>(`[data-count="${lane}"]`)!;
      count.textContent = unread > 0 ? String(unread) : "";

      const body = document.querySelector<HTMLElement>(`[data-body="${lane}"]`)!;
      body.innerHTML = "";
      if (items.length === 0) {
        emptyNote(
          body,
          lane === "newsletter"
            ? "No newsletter items yet."
            : lane === "calendar"
              ? "No upcoming special events on the school calendar."
              : byLaneAll.get(lane)!.length > 0
              ? `Nothing recent in ${LANE_LABELS[lane]}. Older items are under "Open all".`
              : `No ${LANE_LABELS[lane]} items — this source is not switched on yet.`,
        );
      } else {
        // The Calendar card is bounded by its date horizon, not by a row count.
        renderGrouped(
          body,
          items,
          groupsForLane(lane, data.lane_sections, todayIsoDate),
          lane === "calendar" ? null : ROWS_PER_LANE,
        );
      }

      const more = document.querySelector<HTMLButtonElement>(`[data-more="${lane}"]`)!;
      // Offer "Open all" whenever it would show more than the card does: either
      // the card hit its row cap, or older items were filtered out of the card.
      more.hidden =
        byLaneAll.get(lane)!.length <= (lane === "calendar" ? items.length : Math.min(items.length, ROWS_PER_LANE));
      more.textContent = `Open all ${LANE_LABELS[lane]} items`;
    }

    // Keep the "Open all" dialog in step: opening a row from it marks the item
    // read, and the list behind would otherwise still show it as unread.
    if (listDialog.open) renderLaneList();

    const totalUnread = LANES.reduce((sum, lane) => sum + unreadCount(lane), 0);
    $("#new-summary").textContent =
      totalUnread === 0
        ? "Nothing new since your last visit"
        : `${totalUnread} new item${totalUnread === 1 ? "" : "s"} since your last visit`;
  }

  /* --- mobile lane selection --- */

  function selectLane(lane: Lane): void {
    for (const button of document.querySelectorAll<HTMLButtonElement>(".segment")) {
      button.setAttribute("aria-pressed", String(button.dataset.lane === lane));
    }
    for (const section of document.querySelectorAll<HTMLElement>(".lane")) {
      section.classList.toggle("is-active", section.dataset.lane === lane);
    }
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>(".segment")) {
    button.addEventListener("click", () => selectLane(button.dataset.lane as Lane));
  }
  // Default to whichever source has the most unread items.
  const busiest = [...LANES].sort((first, second) => unreadCount(second) - unreadCount(first))[0]!;
  selectLane(busiest);

  /* --- dialogs --- */

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-close-dialog]")) {
    button.addEventListener("click", () => {
      (button.closest("dialog") as HTMLDialogElement | null)?.close();
    });
  }
  // Clicking the backdrop closes; clicking inside must not.
  for (const dialog of [detailDialog, listDialog]) {
    dialog.addEventListener("click", (clickEvent) => {
      if (clickEvent.target === dialog) dialog.close();
    });
    dialog.addEventListener("close", render);
  }
  // Drop the list contents on close so no stale rows sit in the DOM.
  listDialog.addEventListener("close", () => {
    listLane = null;
    $("#list-body").innerHTML = "";
  });

  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-more]")) {
    button.addEventListener("click", () => openLaneList(button.dataset.more as Lane));
  }

  /* --- search --- */

  const searchInput = $("#search-input") as HTMLInputElement;
  const searchSection = $("#search-section");
  const lanesEl = $("#lanes");
  // The bar, not the pill inside it: hiding only the pill would leave the bar's
  // padding behind as a gap during a search.
  const segments = $("#lane-segments-bar");

  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim().toLowerCase();
    if (!query) {
      searchSection.hidden = true;
      lanesEl.hidden = false;
      segments.hidden = false;
      return;
    }
    searchSection.hidden = false;
    lanesEl.hidden = true;
    segments.hidden = true;

    const results = data.events
      .filter((event) =>
        `${event.title} ${event.description} ${event.source.role ?? ""}`
          .toLowerCase()
          .includes(query),
      )
      .sort((first, second) => first.date.localeCompare(second.date));
    const container = $("#search-results");
    container.innerHTML = "";
    if (results.length === 0) emptyNote(container, "No matching items.");
    for (const event of results) container.appendChild(eventRow(event, rowCtx));
  });

  render();
}

async function main(): Promise<void> {
  try {
    const response = await fetch("data/events.json", { cache: "no-store" });
    if (!response.ok) throw new Error(`Failed to load school data (${response.status})`);
    init((await response.json()) as EventsData);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    $("#app-error").hidden = false;
    $("#app-error").textContent = `Couldn't load school data: ${message}`;
  }
}

main();
