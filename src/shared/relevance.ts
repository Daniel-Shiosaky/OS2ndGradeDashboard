// Whether a piece of school writing carries something a parent needs to act on.
//
// Used by the ClassDojo story feed and by school email. Both publish free prose
// written by staff to a page that is publicly reachable, and in both cases the
// filter does double duty: it keeps the dashboard to school business, and it is
// what keeps personal news out. A live class story carried a teacher's pregnancy
// announcement, which matches none of these signals and is therefore withheld.
//
// One shared list on purpose. Two near-identical copies drifted apart in the two
// parsers, and the differences were accidental rather than meaningful.
//
// Widen the list to publish more; narrow it to publish less.

const SCHOOL_RELEVANCE_SIGNALS = [
  // Assessments
  /\btests?\b/i,
  /\bquiz(?:zes)?\b/i,
  /\bassessments?\b/i,
  /\bexams?\b/i,
  // Work to do at home
  /\bhomework\b/i,
  /\bdue\b/i,
  /\bworkbook\b/i,
  /\bstudy guide\b/i,
  /\breading log\b/i,
  /\bpractice\b/i,
  /\bspelling\b/i,
  /\bprojects?\b/i,
  /\bpresentations?\b/i,
  // Things to turn up to, or turn in
  /\bconferences?\b/i,
  /\bfield trip\b/i,
  /\bpermission\b/i,
  /\bdeadline\b/i,
  /\bopen house\b/i,
  /\bpicture day\b/i,
  /\bspirit (?:day|week)\b/i,
  /\bvolunteer\b/i,
  // Things to bring or wear
  /\bbring\b/i,
  /\bwear\b/i,
  /\buniform\b/i,
  /\bdress(?:ed)?\b/i,
  /\blunch\b/i,
  // Timetable changes
  /\bearly dismissal\b/i,
  /\bdismissal\b/i,
  /\bno school\b/i,
  /\bholiday\b/i,
  /\bschedule\b/i,
  /\bcalendar\b/i,
  // Generic framing plus anything explicitly dated
  /\bnewsletter\b/i,
  /\bevent\b/i,
  /\breminder\b/i,
  /\bannouncement\b/i,
  /\b\d{1,2}\/\d{1,2}\b/,
  /\b(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i,
];

/** True when the text mentions something school-actionable. */
export function looksSchoolRelevant(text: string): boolean {
  return SCHOOL_RELEVANCE_SIGNALS.some((pattern) => pattern.test(text));
}
