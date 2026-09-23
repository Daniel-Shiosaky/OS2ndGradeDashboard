// Small text helpers shared by the pipeline. Kept here rather than copied per
// script: slugify previously existed in two files with identical bodies, which is
// exactly the kind of drift that makes event ids stop matching between runs.

/** Lowercase, hyphen-separated form of a title, for use in stable ids. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

/** Escapes a value for safe inclusion in a RegExp. */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Splits a comma-separated env var into trimmed, non-empty values. */
export function splitCommaList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
