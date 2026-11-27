import { z } from "zod";

export const CATEGORIES = [
  "homework",
  "test",
  "quiz",
  "project",
  "event",
  "field_trip",
  "deadline",
  "supplies",
  "announcement",
  "holiday",
  "no_school",
  "early_dismissal",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export const IMPORTANCE_LEVELS = ["high", "medium", "low"] as const;
export type Importance = (typeof IMPORTANCE_LEVELS)[number];

/** The three dashboard lanes, one per source, so parents know where to look. */
export const LANES = ["newsletter", "classdojo", "email"] as const;
export type Lane = (typeof LANES)[number];

export const SourceRefSchema = z.object({
  name: z.string().min(1),
  url: z.string().url().optional(),
  lane: z.enum(LANES).default("newsletter"),
  /** Heading this source's items appear under inside its lane. */
  section: z.string().optional(),
  /**
   * Who sent it, by ROLE never by person: "2nd grade teachers", "Cafeteria",
   * "PTA". This dashboard is shared by both 2nd-grade classes, so no teacher,
   * family, parent or student name appears anywhere.
   */
  role: z.string().optional(),
});
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const SchoolEventSchema = z.object({
  id: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD"),
  time: z.string().nullable().default(null),
  title: z.string().min(1),
  category: z.enum(CATEGORIES),
  description: z.string().default(""),
  importance: z.enum(IMPORTANCE_LEVELS).default("medium"),
  source: SourceRefSchema,
  uncertain: z.boolean().default(false),
  /** Shown as a "Whole school" tag when the item is not specific to 2nd grade. */
  whole_school: z.boolean().default(false),
  /**
   * When the item arrived, for the reverse-chronological ClassDojo and Email
   * lanes. Newsletter items have no arrival time and fall back to `date`.
   */
  received_at: z.string().optional(),
});
export type SchoolEvent = z.infer<typeof SchoolEventSchema>;

/**
 * The newsletter reproduced as its own sub-sections, so the dashboard can show
 * the full week's notes the way the teachers grouped them — not only the items
 * that happened to carry a date.
 */
export const NewsletterSectionSchema = z.object({
  heading: z.string().min(1),
  items: z.array(z.string()),
});

export const NewsletterDigestSchema = z.object({
  title: z.string().min(1),
  week_label: z.string().default(""),
  source: SourceRefSchema,
  sections: z.array(NewsletterSectionSchema),
});
export type NewsletterDigest = z.infer<typeof NewsletterDigestSchema>;

export const EventsDataSchema = z.object({
  /** Class name used as the dashboard title, e.g. "2nd Grade". */
  school_name: z.string().min(1),
  /**
   * Section headings per lane, in display order, derived from data/sources.json.
   * Published so the frontend never restates them: renaming a section in config
   * would otherwise silently stop matching and drop every row into "Other".
   */
  lane_sections: z.record(z.enum(LANES), z.array(z.string())).default({}),
  newsletter: NewsletterDigestSchema.optional(),
  // IANA zone the school's dates are expressed in. Published so the frontend can
  // decide what "today" is locally instead of assuming UTC.
  timezone: z.string().default("UTC"),
  last_updated: z.string().min(1),
  events: z.array(SchoolEventSchema),
});
export type EventsData = z.infer<typeof EventsDataSchema>;

export const SourceConfigEntrySchema = z
  .object({
    name: z.string().min(1),
    // Required for website/calendar/pdf/school_portal (the page to read).
    // Not applicable to gmail, which is configured via env vars instead.
    // Use urlEnv instead to keep an identifying URL (e.g. a school's real
    // subdomain) out of a committed/public sources.json.
    url: z.string().url().optional(),
    urlEnv: z.string().optional(),
    // google_doc     — public Google Doc read via its plain-text export URL.
    //                  No auth, no browser; runs anywhere including CI.
    // newsletter_board — logs into the school portal, finds the newest weekly
    //                  newsletter link on a group bulletin board, then reads
    //                  that (public) Google Doc. Login means local-only.
    // classdojo — logs into the ClassDojo parent app and reads one of its SPA
    //              pages (#/events, #/story). Login means local-only.
    type: z.enum([
      "website",
      "calendar",
      "pdf",
      "gmail",
      "school_portal",
      "google_doc",
      "newsletter_board",
      "classdojo",
    ]),
    enabled: z.boolean().default(true),
    // Sources needing an interactive login can't run on a CI runner: set this
    // so scheduled workflows skip them instead of failing the run.
    localOnly: z.boolean().default(false),
    // newsletter_board only: matches the announcement link text to pick out
    // newsletter links from everything else pinned to the board.
    titlePattern: z.string().optional(),
    priority: z.number().int().min(1).default(99),
    // gmail-only: restrict the mailbox search to a specific sender. Use
    // filterFromEnv instead to keep a real address out of a committed file.
    filterFrom: z.string().email().optional(),
    filterFromEnv: z.string().optional(),
    // gmail-only: how many days back to search. Defaults applied in fetchSources.
    lookbackDays: z.number().int().min(1).optional(),
    // Which dashboard lane this source feeds. Defaults by type; ClassNojo-style
    // digest mailboxes must set "classdojo" explicitly since they arrive as mail.
    lane: z.enum(LANES).optional(),
    // Role label shown as the sender, e.g. "2nd grade teachers", "Cafeteria".
    role: z.string().optional(),
    // Heading this source's items group under in its lane, e.g. "Teachers".
    section: z.string().optional(),
    // gmail-only: this sender ONLY ever broadcasts (a school comms or newsletter
    // address), so per-message broadcast detection is skipped. Never set it for a
    // sender who also writes to individual families, such as a class teacher.
    broadcastChannel: z.boolean().default(false),
    // Marks a source as school-wide rather than 2nd-grade specific.
    wholeSchool: z.boolean().default(false),
  })
  .refine((entry) => entry.type === "gmail" || entry.url !== undefined || entry.urlEnv !== undefined, {
    message: "url or urlEnv is required for all source types except gmail",
    path: ["url"],
  });
export type SourceConfigEntry = z.infer<typeof SourceConfigEntrySchema>;

/**
 * Overrides an item's lane section by what its title says, regardless of which
 * source it arrived from. The school's "Inside the Spark" newsletter belongs
 * under general announcements wherever it is forwarded from.
 */
export const SectionRuleSchema = z.object({
  titlePattern: z.string().min(1),
  section: z.string().min(1),
});
export type SectionRule = z.infer<typeof SectionRuleSchema>;

export const SourcesConfigSchema = z.object({
  school_name: z.string().min(1),
  timezone: z.string().default("UTC"),
  sources: z.array(SourceConfigEntrySchema),
  sectionRules: z.array(SectionRuleSchema).default([]),
});

// whole_school comes from the source's config, not from the extracted text, so
// extractors neither see nor set it.
export const ExtractedEventSchema = SchoolEventSchema.omit({
  id: true,
  source: true,
  whole_school: true,
}).extend({
  title: z.string().min(1),
});
export type ExtractedEvent = z.infer<typeof ExtractedEventSchema>;

export const ExtractionResultSchema = z.object({
  events: z.array(ExtractedEventSchema),
  conflicts: z
    .array(
      z.object({
        description: z.string(),
      }),
    )
    .default([]),
});

export interface ChangeLogEntry {
  type: "new" | "changed" | "removed";
  event: SchoolEvent;
  previous?: Partial<SchoolEvent>;
}
