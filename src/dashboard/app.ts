// Phase 1 dashboard frontend. Reads data/events.json client-side, computes
// This Week / Upcoming / Important / Supplies / Announcements / Sources
// (project brief section 16), and supports a simple client-side search
// (section 17). No backend required — works from the sample JSON as-is.

import { getCurrentWeekRange, isWithinRange, isAfterRange, type WeekRange } from "../shared/weekRange.js";
import type { Category, EventsData, Importance, SchoolEvent } from "../types/schema.js";

const CATEGORY_LABELS: Record<Category, string> = {
  homework: "Homework",
  test: "Test",
  quiz: "Quiz",
  project: "Project",
  event: "Event",
  field_trip: "Field Trip",
  deadline: "Deadline",
  supplies: "Supplies",
  announcement: "Announcement",
  holiday: "Holiday",
  no_school: "No School",
  early_dismissal: "Early Dismissal",
  other: "Other",
};

const CATEGORY_ICONS: Record<Category, string> = {
  homework: "📐",
  test: "🧪",
  quiz: "🧪",
  project: "📁",
  event: "📸",
  field_trip: "🚌",
  deadline: "⏰",
  supplies: "🎒",
  announcement: "📢",
  holiday: "🎉",
  no_school: "🚫",
  early_dismissal: "⏱️",
  other: "📌",
};

const IMPORTANCE_LABELS: Record<Importance, string> = {
  high: "Important",
  medium: "Medium",
  low: "Low",
};

function $(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`Missing element: ${selector}`);
  return el;
}

function formatDateLabel(dateStr: string): string {
  const date = new Date(`${dateStr}T00:00:00Z`);
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatWeekLabel(range: WeekRange): string {
  const start = new Date(`${range.weekStart}T00:00:00Z`);
  const end = new Date(`${range.weekEnd}T00:00:00Z`);
  const startLabel = start.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
  const endLabel = end.toLocaleDateString("en-US", { day: "numeric", timeZone: "UTC" });
  return `${startLabel} – ${endLabel}`;
}

function isPast(dateStr: string, todayStr: string): boolean {
  return dateStr < todayStr;
}

function eventCard(event: SchoolEvent): HTMLElement {
  const card = document.createElement("article");
  card.className = `card card--${event.importance}`;

  const header = document.createElement("div");
  header.className = "card__header";

  const badge = document.createElement("span");
  badge.className = `badge badge--category`;
  badge.textContent = `${CATEGORY_ICONS[event.category]} ${CATEGORY_LABELS[event.category]}`;
  header.appendChild(badge);

  if (event.importance === "high") {
    const importanceBadge = document.createElement("span");
    importanceBadge.className = "badge badge--important";
    importanceBadge.textContent = IMPORTANCE_LABELS.high;
    header.appendChild(importanceBadge);
  }

  if (event.uncertain) {
    const uncertainBadge = document.createElement("span");
    uncertainBadge.className = "badge badge--uncertain";
    uncertainBadge.textContent = "Unconfirmed";
    header.appendChild(uncertainBadge);
  }

  card.appendChild(header);

  const title = document.createElement("h3");
  title.className = "card__title";
  title.textContent = event.title;
  card.appendChild(title);

  const when = document.createElement("p");
  when.className = "card__when";
  when.textContent = event.time ? `${formatDateLabel(event.date)} · ${event.time}` : formatDateLabel(event.date);
  card.appendChild(when);

  if (event.description) {
    const desc = document.createElement("p");
    desc.className = "card__description";
    desc.textContent = event.description;
    card.appendChild(desc);
  }

  const source = document.createElement("p");
  source.className = "card__source";
  if (event.source.url) {
    const link = document.createElement("a");
    link.href = event.source.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = `Source: ${event.source.name}`;
    source.appendChild(link);
  } else {
    source.textContent = `Source: ${event.source.name}`;
  }
  card.appendChild(source);

  return card;
}

function renderSection(containerId: string, events: SchoolEvent[], emptyMessage: string): void {
  const container = $(containerId);
  container.innerHTML = "";
  if (events.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = emptyMessage;
    container.appendChild(empty);
    return;
  }
  for (const event of events) {
    container.appendChild(eventCard(event));
  }
}

function renderSources(events: SchoolEvent[]): void {
  const container = $("#sources-list");
  container.innerHTML = "";

  const seen = new Map<string, string | undefined>();
  for (const event of events) {
    if (!seen.has(event.source.name)) {
      seen.set(event.source.name, event.source.url);
    }
  }

  if (seen.size === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-message";
    empty.textContent = "No sources yet.";
    container.appendChild(empty);
    return;
  }

  const list = document.createElement("ul");
  list.className = "source-list";
  for (const [name, url] of seen) {
    const item = document.createElement("li");
    if (url) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = name;
      item.appendChild(link);
    } else {
      item.textContent = name;
    }
    list.appendChild(item);
  }
  container.appendChild(list);
}

function matchesSearch(event: SchoolEvent, query: string): boolean {
  const haystack = `${event.title} ${event.description} ${CATEGORY_LABELS[event.category]}`.toLowerCase();
  return haystack.includes(query);
}

function renderSearchResults(events: SchoolEvent[], query: string): void {
  const results = events
    .filter((e) => matchesSearch(e, query))
    .sort((a, b) => a.date.localeCompare(b.date));
  renderSection("#search-results", results, "No matching events.");
}

async function loadEvents(): Promise<EventsData> {
  const response = await fetch("data/events.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load event data (${response.status})`);
  }
  return response.json();
}

function render(data: EventsData): void {
  $("#school-name").textContent = data.school_name;
  const updated = new Date(data.last_updated);
  $("#last-updated").textContent = Number.isNaN(updated.getTime())
    ? ""
    : `Updated ${updated.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })}`;

  const todayStr = new Date().toISOString().slice(0, 10);
  const weekRange = getCurrentWeekRange();
  $("#week-range").textContent = formatWeekLabel(weekRange);

  const upcomingOnly = data.events.filter((e) => !isPast(e.date, todayStr));

  const thisWeek = upcomingOnly
    .filter((e) => isWithinRange(e.date, weekRange))
    .sort((a, b) => a.date.localeCompare(b.date));

  const upcoming = upcomingOnly
    .filter((e) => isAfterRange(e.date, weekRange))
    .sort((a, b) => a.date.localeCompare(b.date));

  const important = upcomingOnly
    .filter((e) => e.importance === "high")
    .sort((a, b) => a.date.localeCompare(b.date));

  const supplies = upcomingOnly
    .filter((e) => e.category === "supplies")
    .sort((a, b) => a.date.localeCompare(b.date));

  const announcements = data.events
    .filter((e) => e.category === "announcement")
    .sort((a, b) => b.date.localeCompare(a.date));

  renderSection("#this-week-list", thisWeek, "Nothing scheduled this week.");
  renderSection("#upcoming-list", upcoming, "Nothing upcoming yet.");
  renderSection("#important-list", important, "No high-priority items right now.");
  renderSection("#supplies-list", supplies, "Nothing to bring right now.");
  renderSection("#announcements-list", announcements, "No announcements.");
  renderSources(data.events);

  const searchInput = $("#search-input") as HTMLInputElement;
  const searchSection = $("#search-section");
  const mainSections = $("#main-sections");
  searchInput.addEventListener("input", () => {
    const query = searchInput.value.trim().toLowerCase();
    if (query.length === 0) {
      searchSection.hidden = true;
      mainSections.hidden = false;
      return;
    }
    searchSection.hidden = false;
    mainSections.hidden = true;
    renderSearchResults(data.events, query);
  });
}

async function init(): Promise<void> {
  try {
    const data = await loadEvents();
    render(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    $("#app-error").hidden = false;
    $("#app-error").textContent = `Couldn't load school data: ${message}`;
  }
}

init();
