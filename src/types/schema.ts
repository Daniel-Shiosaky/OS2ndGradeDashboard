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

export const SourceRefSchema = z.object({
  name: z.string().min(1),
  url: z.string().url().optional(),
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
});
export type SchoolEvent = z.infer<typeof SchoolEventSchema>;

export const EventsDataSchema = z.object({
  school_name: z.string().min(1),
  last_updated: z.string().min(1),
  events: z.array(SchoolEventSchema),
});
export type EventsData = z.infer<typeof EventsDataSchema>;

export const WeekDataSchema = z.object({
  week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  week_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  last_updated: z.string().min(1),
  events: z.array(SchoolEventSchema),
});
export type WeekData = z.infer<typeof WeekDataSchema>;

export const SourceConfigEntrySchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  type: z.enum(["website", "calendar", "pdf"]),
  enabled: z.boolean().default(true),
  priority: z.number().int().min(1).default(99),
});
export type SourceConfigEntry = z.infer<typeof SourceConfigEntrySchema>;

export const SourcesConfigSchema = z.object({
  school_name: z.string().min(1),
  timezone: z.string().default("UTC"),
  sources: z.array(SourceConfigEntrySchema),
});
export type SourcesConfig = z.infer<typeof SourcesConfigSchema>;

export const ExtractedEventSchema = SchoolEventSchema.omit({ id: true, source: true }).extend({
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
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

export interface ConflictRecord {
  title: string;
  candidates: Array<{ date: string; source: SourceRef }>;
  resolved: { date: string; source: SourceRef };
  note: string;
}

export interface ChangeLogEntry {
  type: "new" | "changed" | "removed";
  event: SchoolEvent;
  previous?: Partial<SchoolEvent>;
}
