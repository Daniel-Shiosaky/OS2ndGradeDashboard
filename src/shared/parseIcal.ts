// Minimal iCalendar (RFC 5545) reader for the school calendar feed.
//
// Reads only what the Calendar lane needs: VEVENT summary, start/end, location,
// description, url, status and whether it recurs. It is deliberately not a full
// implementation — no VTIMEZONE rules, no RRULE expansion. An event that carries
// an RRULE is reported as recurring so the caller can treat it as routine.
//
// Isomorphic (no Node APIs) so it can be unit-tested and reused anywhere.

export type IcalDateTime =
  /** All-day event: a calendar date with no time or zone (VALUE=DATE). */
  | { kind: "date"; date: string }
  /** Wall-clock time in the named zone (DTSTART;TZID=America/New_York:...). */
  | { kind: "local"; date: string; time: string; timeZone: string | null }
  /** An absolute instant (a trailing Z). */
  | { kind: "utc"; instant: Date };

export interface IcalEvent {
  uid: string;
  summary: string;
  description: string;
  location: string;
  url: string;
  status: string;
  start: IcalDateTime;
  end: IcalDateTime | null;
  /** True when the event has an RRULE, so it is one of a series. */
  recurring: boolean;
}

/** Undoes RFC 5545 TEXT escaping: \n, \N, \, \; and \\. */
export function unescapeIcalText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_match, escaped: string) =>
    escaped === "n" || escaped === "N" ? "\n" : escaped,
  );
}

/** Lines folded with a leading space or tab continue the previous line. */
function unfold(text: string): string[] {
  return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseProperty(line: string): Property | null {
  const colon = line.indexOf(":");
  if (colon <= 0) return null;
  const [rawName = "", ...rawParams] = line.slice(0, colon).split(";");
  const params: Record<string, string> = {};
  for (const rawParam of rawParams) {
    const equals = rawParam.indexOf("=");
    if (equals > 0) params[rawParam.slice(0, equals).toUpperCase()] = rawParam.slice(equals + 1).replace(/^"|"$/g, "");
  }
  return { name: rawName.toUpperCase(), params, value: line.slice(colon + 1) };
}

/** 20261215 -> 2026-12-15; null when it is not a valid-looking date. */
function toIsoDate(compact: string): string | null {
  const match = compact.match(/^(\d{4})(\d{2})(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function parseDateTime(property: Property): IcalDateTime | null {
  const value = property.value.trim();

  if (property.params.VALUE === "DATE" || /^\d{8}$/.test(value)) {
    const date = toIsoDate(value);
    return date ? { kind: "date", date } : null;
  }

  const match = value.match(/^(\d{8})T(\d{2})(\d{2})(\d{2})?(Z)?$/);
  if (!match) return null;
  const date = toIsoDate(match[1]!);
  if (!date) return null;

  if (match[5] === "Z") {
    const instant = new Date(`${date}T${match[2]}:${match[3]}:${match[4] ?? "00"}Z`);
    return Number.isNaN(instant.getTime()) ? null : { kind: "utc", instant };
  }
  return { kind: "local", date, time: `${match[2]}:${match[3]}`, timeZone: property.params.TZID ?? null };
}

export function parseIcal(text: string): IcalEvent[] {
  const events: IcalEvent[] = [];
  let current: Partial<IcalEvent> | null = null;

  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") {
      current = { uid: "", summary: "", description: "", location: "", url: "", status: "", end: null, recurring: false };
      continue;
    }
    if (line === "END:VEVENT") {
      if (current?.start) events.push(current as IcalEvent);
      current = null;
      continue;
    }
    if (!current) continue;

    const property = parseProperty(line);
    if (!property) continue;
    switch (property.name) {
      case "UID":
        current.uid = property.value.trim();
        break;
      case "SUMMARY":
        current.summary = unescapeIcalText(property.value).trim();
        break;
      case "DESCRIPTION":
        current.description = unescapeIcalText(property.value).trim();
        break;
      case "LOCATION":
        current.location = unescapeIcalText(property.value).trim();
        break;
      case "URL":
        current.url = property.value.trim();
        break;
      case "STATUS":
        current.status = property.value.trim().toUpperCase();
        break;
      case "RRULE":
        current.recurring = true;
        break;
      case "DTSTART": {
        const start = parseDateTime(property);
        if (start) current.start = start;
        break;
      }
      case "DTEND": {
        current.end = parseDateTime(property);
        break;
      }
      default:
        break;
    }
  }
  return events;
}
