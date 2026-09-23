# 2nd Grade Dashboard — architecture, decisions and learnings

One shared dashboard for both 2nd-grade classes at One School. It gathers the
week's school information from three sources, strips anything personal, and
publishes a static page parents open from a link shared in WhatsApp.

This document is the working record: what the system does, why it is built this
way, and the things that turned out to be wrong on the first attempt. It
replaces the original product brief, which described a generic design before any
real source had been inspected.

---

## 1. What it produces

A static site (GitHub Pages) with **three lanes, one per source**, so a parent
always knows where to look:

| Lane | Source | Sections |
| --- | --- | --- |
| Newsletter | the week's Google Doc, found via the school portal | Tests / Homework / To do / Events |
| ClassDojo | the parent app's JSON APIs | Upcoming / Messages |
| Email | broadcast school mail over IMAP | Teachers / General announcements / … |

Desktop shows three columns; below 760px a segmented control under the header
shows one lane at a time. Unread state is per browser (`localStorage`) because
there is no login.

---

## 2. Pipeline

```
fetchSources.ts      per-source fetch, fails safely  →  output/raw/<slug>.json
processWithAi.ts     deterministic parse, AI fallback →  data/pending-review.json
generateDashboard.ts merge + conflict resolution      →  data/events.json
                                                      →  output/whatsapp-message.txt
validateData.ts      schema + duplicate-id check      →  exits non-zero on failure
```

`updatePipeline.ts` chains all four and is what the scheduled workflow runs. The
frontend reads `data/events.json` client-side; there is no backend at request
time.

### The AI is the fallback, not the engine

Every source is parsed **deterministically** first. The AI only runs when a
parser returns nothing, which signals the source changed shape.

This was not the original plan. It changed after a free-tier daily quota (20
requests) was exhausted during one afternoon of testing and blocked the whole
pipeline. The newsletter turned out to be a fixed template, and a plain parser
found **9 of 9** dated items — so the model was never needed for the normal case.
Deterministic parsing also means no cost, no rate limit, reproducible output, no
invented dates, and redaction that is mechanical rather than a request a model
may or may not honour.

`aiProvider.ts` keeps Anthropic / OpenAI / Gemini behind one interface, honours
`Retry-After` and Gemini's `RetryInfo`, and is configured entirely by env vars.

---

## 3. Sources: what actually worked

### 3.1 Newsletter — portal for discovery, public doc for content

A **new Google Doc every week**, linked from the 2nd Grade Parent Group bulletin
board. So the job splits in two:

- **Discovery** needs a portal login. The board is scraped for links, and the
  newest is chosen by the `M/D` range in its title, not by DOM order.
- **Content** needs nothing. The docs are link-shared, so
  `…/export?format=txt` returns clean text over plain HTTP — no browser, no
  credentials.

The published row links the doc itself, so parents can open the original.

**Portal login is three hops, not one form** (`loginToPortal`):

1. MySchoolApp collects only the username and submits `#nextBtn`.
2. It redirects to `app.blackbaud.com/signin`, where the email arrives
   prepopulated; Continue advances.
3. The password step is an **Azure AD B2C form inside an iframe** served from
   `id.blackbaud.com`. Playwright pierces shadow DOM but never frame
   boundaries, so `page.locator("#password")` finds nothing on the main frame.
   It must be reached through a `frameLocator`, matched **by URL** because the
   iframe's name is regenerated per load (`sky-id-gen__<timestamp>__1`).

A first login from an unrecognised device can also demand a 6-digit emailed
code, which no unattended run can satisfy — hence `localOnly`.

### 3.2 ClassDojo — use the JSON APIs, not the DOM

```
/api/parentCalendarEvent?limit=50&hidePastEvents=true
/api/storyFeed?withStudentCommentsAndLikes=false&withSyntheticPosts=false
```

The browser is only used to obtain a session cookie. The APIs removed every
heuristic the DOM version needed: `startDate` is already `YYYY-MM-DD`, `time` is
a real ISO instant (no more parsing "15 minutes ago"), `contents.body` is the
post without nav chrome or Like/Comment footers, past events are filtered
server-side, and events carry a `description` the rendered page never exposed.

Two query parameters are deliberate:

- `withStudentCommentsAndLikes=false` — comments are written by other parents
  and children. Not requesting them means those names never reach this process,
  which is stronger than redacting them later.
- `withSyntheticPosts=false` — drops "CLASS EVENT" reposts that duplicate the
  calendar feed.

Responses still contain `teacher`, `senderName`, `headerText` and
`classroom.name`; none of those fields are read.

### 3.3 Email — broadcast only

This reads a **personal mailbox**, so the filter is the feature. A message is
published only if it clears every gate: a positive broadcast signal, no billing
wording, no direct-message subject, no configured child name, and something
school-actionable. Only derived signals are stored — never other recipients'
addresses, and never message IDs.

Broadcast signals, all learned from real mail:

- `List-Unsubscribe` / `List-Id` / `Precedence: bulk`
- `undisclosed-recipients`
- a known mass-mail sending domain (`MAIL_BULK_DOMAINS`)
- **zero visible recipients** — the teacher BCC'd the class
- three or more addressees

`broadcastChannel: true` marks a sender that *only* ever broadcasts (a school
communications address). Needed because the school's own newsletter is
**header-identical to a private reply**: individually addressed, from the same
domain a teacher uses for direct mail. No detection can separate those, so an
administrator names the channel instead. A class teacher must never set it.

---

## 4. Privacy model

Everything extracted is published to a **public URL**, so this is the core
constraint, not a footnote.

**Removed:** children's names (listed in `REDACT_NAMES`, since no pattern can
safely infer a first name), other families' surnames (`the <Surname> Family` → `a
family`), credential lines, email addresses, phone numbers.

**Kept on purpose:** staff names. Removing them destroyed real meaning — the
newsletter lists one Q1 conference day per teacher, so stripping names produced
two identical "Q1 Conferences" rows on different dates with no way to tell which
applied to you. Staff are named in their professional capacity in a document the
school already distributes.

**Withheld whole, not redacted:** a message naming a child. A subject like
`"<Child>'s Q1 Conference Invite"` redacts to `"Q1 Conference Invite"`, which
reads like a class notice but was written to one family.

**Relevance as a privacy filter:** the ClassDojo story feed and school email
publish only posts with school-actionable content. That is what keeps personal
news out — a live feed carried a teacher's pregnancy announcement, which matches
no signal and is therefore withheld. Under-publishing is recoverable;
over-publishing to a public URL is not.

Also: `noindex` plus `robots.txt`, real fetched content confined to gitignored
`output/raw/`, and test fixtures are **synthetic wherever they would contain
names** — committing the real ClassDojo story feed would have been exactly the
leak the parser prevents.

### Residual risks

- A teacher's class broadcast can name another child; only names in
  `REDACT_NAMES` are stripped.
- The Pages site is publicly reachable. `noindex` is a request to crawlers, not
  access control.
- `data/events.json` and `output/whatsapp-message.txt` are committed to a public
  repo. Both are scanned clean, but they are public.

---

## 5. Configuration — nothing week-specific in code

The data changes every week, so no dates, URLs, section names or senders are
hardcoded.

| Where | What |
| --- | --- |
| `data/sources.json` | sources, lanes, sections, roles, priorities, `sectionRules` |
| `.env` (gitignored) | credentials, `REDACT_NAMES`, `MAIL_BULK_DOMAINS` |
| GitHub secrets | the same names for CI |
| `events.json` | `lane_sections`, `timezone`, published for the frontend |

Two indirections worth knowing:

- **`urlEnv` / `filterFromEnv`** hold the *name* of an env var, so a real school
  subdomain or teacher address never appears in a committed file.
- **`lane_sections`** is derived from config and published with the data, so the
  frontend never restates section names. It used to, and renaming a section in
  config would have silently dropped every row into "Other". Section **order**
  now follows source order in `sources.json`.

`sectionRules` files an item by title whatever source forwarded it — e.g.
`"Inside the Spark"` → General announcements.

---

## 6. Reliability

- A failing source is logged and skipped; it never erases other sources' data.
- Empty extractions never overwrite good data.
- `validateData.ts` exits non-zero on schema errors or duplicate ids, so bad
  data cannot reach Pages.
- **Pages deploys even when the pipeline fails.** The pipeline step is
  `continue-on-error`, the previously committed data is validated and published,
  and a final step still fails the run. `deploy` uses `!cancelled()`, because
  GitHub otherwise skips a job whose dependency is red.
- Portal and ClassDojo sources are `localOnly`: interactive logins cannot run
  unattended, so scheduled runs skip them rather than failing.

---

## 7. Bugs worth remembering

Each of these is now covered by a named regression test.

**Timezone.** `new Date().toISOString().slice(0,10)` is not "today". At 8pm in
New York it is already tomorrow in UTC, so same-day events vanished from the
dashboard hours early and the newsletter parser resolved bare `M/D` dates against
the wrong year. Everything now derives the date from the school's zone.

**`[hidden]` loses to any author `display` rule.** The JS correctly set `hidden`,
but `.dialog__link { display: inline-block }` outranks the user-agent
`[hidden] { display: none }`. A dead "Open the original" link rendered on email
items, and the three lanes stayed visible behind search results. Fixed globally
with `[hidden] { display: none !important }` placed before anything that sets
`display`. The lesson: assert visibility with `isVisible()`, never
`element.hidden` — checking the property reported success while the element was
plainly on screen.

**Recurring events were silently dropped.** `mergeEvents` grouped by title alone,
so two Q1 conference days collapsed into one and logged a bogus CONFLICT. A
conflict now requires *different sources* disagreeing; one source on several
dates is several occurrences.

**Truncation kept the stalest content.** IMAP returns mail oldest-first, and a
20k-char prompt cap discarded the newest 4 of 11 teacher emails — the most
relevant ones. Now newest-first, with a visible warning when a cap bites.

**Broadcast detection, four wrong turns.** A "sole recipient means direct" rule
rejected every school mass-mail, because mass-mailers address each copy
individually. `confidential` matched the footer disclaimer on every message and
killed all six teacher broadcasts. A bare `$` match rejected the school's own
newsletter as billing. Keyword-based relevance dropped "Extended Care Location
Change For Today". Body text is noisy: subject-only checks plus footer trimming
fixed all four.

**Rows dealt in order starved later sections.** Teachers took 6 of 8 slots and
the school newsletter never appeared under General announcements. Rows are now
dealt one per section in rotation.

**`networkidle` never fires on these SPAs.** Both portals hold connections open;
worse, reading too early returns ~200 chars of nav shell instead of ~10k of
content. Replaced with polling until the DOM text stabilises.

**Two "not viable" verdicts that were wrong.** The portal's reCAPTCHA notice was
boilerplate beside an emailed OTP, not bot-blocking. ClassDojo does not 403
headless browsers — it answers 200. Both conclusions came from reading a
screenshot too quickly. Inspect the frame tree and the actual response before
declaring something impossible.

---

## 8. Conventions

- camelCase throughout; `snake_case` only in published JSON field names, which
  are a data contract.
- Descriptive identifiers — no single characters, including in lambdas and
  comparators (`(first, second)`, not `(a, b)`).
- Shared helpers live in `src/shared/`: `text.ts` (`slugify`, `escapeRegExp`,
  `splitCommaList`), `weekRange.ts` (all date/zone maths), `redact.ts`,
  `relevance.ts`. Each of those existed as duplicated copies first, and the
  copies drifted.
- Comments explain *why*, especially where a simpler approach was tried and
  failed.
- Tests use fixed reference dates against fixed fixtures — deterministic by
  design, not hardcoded live data.

## 9. Removed deliberately

- **`data/current-week.json`** — generated, committed and published, but read by
  nobody. The frontend derives the week from `events.json` plus `timezone`.
- **`WeekDataSchema`, `ConflictRecord`, `soleRecipientIsMe`** and other unused
  exports.
- **Direct ClassDojo/portal DOM scraping**, superseded by APIs and the public doc
  export.
- **"Mark all read"** and the `data/sources.json` PDF/website placeholders, which
  point at `example.com`.

## 10. Open items

- Email lane's **School portal** section has no source: the `school_portal` type
  targets the old single-domain login form and does not work against the current
  federated flow.
- **No removed-event detection.** `events.json` grows; past events are filtered
  client-side only.
- `README.md` still describes the earlier single-column UI in places.
- Link-preview (Open Graph) tags for sharing the URL in WhatsApp: the static
  `<title>` is generic and the crawler does not run JavaScript, so a pasted link
  previews poorly.
