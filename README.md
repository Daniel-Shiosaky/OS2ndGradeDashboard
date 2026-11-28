# 2nd Grade Dashboard

One shared dashboard for both 2nd-grade classes. It gathers the week's school
information from four sources, strips anything personal, and publishes a
static page that parents open from a link shared in a group chat. It runs at
about $0/month on GitHub Pages and GitHub Actions, with no database and no
server at request time.

The dashboard **organizes information, it does not invent it**: every event
carries a source, and anything uncertain is marked or left out.

The full design record — decisions, privacy model, and the bugs that shaped
them — is in [`Docs/osclassinfo.md`](./Docs/osclassinfo.md). Read that before
changing how a source is parsed.

## What parents see

Four lanes, one per source, so a parent always knows where to look:

| Lane | Source | Sections |
| --- | --- | --- |
| Newsletter | the week's Google Doc, found via the school portal | Tests / Homework / To do / Events |
| ClassDojo | the parent app's JSON APIs | Upcoming / Messages |
| Email | broadcast school mail over IMAP | Teachers / General announcements |
| Calendar | the school's MyOS calendar, as an iCalendar feed (no login) | Schedule changes / Concerts & performances / School events |

Desktop shows four columns on wide screens and two on mid-size ones. Below 760px a
segmented control under the header shows one lane at a time. "New" is worked out per browser, because there is no login: an item is new when it was
not on the dashboard at your previous visit, and it stays marked until you open it. A
first visit shows nothing as new, and a reload keeps the same count.

## How it works

```
fetchSources.ts       per-source fetch, fails safely   →  output/raw/<slug>.json
processWithAi.ts      deterministic parse, AI fallback →  data/pending-review.json
generateDashboard.ts  merge + conflict resolution      →  data/events.json
                                                       →  output/whatsapp-message.txt
validateData.ts       schema + duplicate-id check      →  exits non-zero on failure
```

`src/scripts/updatePipeline.ts` chains all four and is what the scheduled
workflow runs. The frontend (`src/dashboard/app.ts`, bundled to
`public/app.js`) reads `data/events.json` client-side.

**The AI is the fallback, not the engine.** Every source is parsed
deterministically first (`src/shared/parse*.ts`). The AI only runs when a parser
returns nothing, which means the source changed shape. That keeps normal runs
free, reproducible, and unable to invent dates, and it makes redaction
mechanical instead of a request a model may or may not honour.

Only the newest raw file for each enabled source is processed, so old weekly
newsletters and removed sources do not leak back in. When a newer weekly
newsletter arrives, events from the older issue are dropped from the data.

## Local development

```bash
npm install
npm run playwright:install   # Chromium, used by the portal and ClassDojo fetchers
npm run dev                  # builds the bundle, serves http://localhost:8080
```

`npm run dev` serves `public/` at `/` and `data/` at `/data/`, matching the
deployed layout (override the port with `PORT=...`). It shows whatever is in
`data/events.json`; that file is generated and gitignored, so on a fresh clone
run the pipeline first.

```bash
npm run typecheck
npm test                     # fixed fixtures and reference dates — no network, no AI
```

### Credentials

```bash
cp .env.example .env
```

`.env` is gitignored and **must never be committed**. In GitHub Actions the same
names come from repository secrets. Every variable is documented in
[`.env.example`](./.env.example).

### Running the pipeline

```bash
npm run pipeline             # all four steps
npm run fetch-sources        # or any step on its own
npm run process-ai
npm run generate-dashboard
npm run validate-data
```

### Signing in to the school portal

The newsletter lane needs the portal only to *find* the week's Google Doc; the
doc itself is link-shared and is fetched over plain HTTP. The portal login is
three hops (username, then a Blackbaud sign-in page, then a password form inside
an iframe), and a login from an unrecognised device demands a 6-digit code
emailed to the account.

A fresh headless browser looks like a new device every run, so the pipeline
keeps a browser profile in `output/browser-profile/` (gitignored — it holds a
live session). Sign in once:

```bash
npm run portal-login         # opens a window; type the emailed code when asked
```

After that, `npm run pipeline` reuses the saved session. If the portal asks for a
code again, run `npm run portal-login` again.

## Configuring sources

Everything week-specific lives in config, never in code.

- **`data/sources.json`** — the sources, their lane and section, priorities,
  and `sectionRules` (file an item under a section by its title, whichever
  source forwarded it). A lower `priority` number wins when two *different*
  sources disagree about the same event. Section order follows source order.
- **`.env` / GitHub secrets** — credentials, `REDACT_NAMES`, `MAIL_BULK_DOMAINS`.
- **`urlEnv` / `filterFromEnv`** — a source can hold the *name* of an env var
  instead of a literal URL or sender address, so a real school subdomain or
  teacher address never appears in a committed file:

  ```json
  { "name": "Teacher Emails", "type": "gmail", "filterFromEnv": "GMAIL_FILTER_TEACHER" }
  ```

`lane_sections` is derived from this config and published with the data, so the
frontend never restates section names.

### Source types

- **`newsletter_board`** — scrapes the portal bulletin board for newsletter
  links, picks the newest by the `M/D` range in its title, then reads the Google
  Doc's `export?format=txt`.
- **`classdojo`** — the parent app's own JSON APIs, with a browser used only to
  obtain a session cookie. Two query parameters are deliberate:
  `withStudentCommentsAndLikes=false` (comments are written by other parents and
  children, so those names never reach this process) and
  `withSyntheticPosts=false` (drops reposts that duplicate the calendar feed).
  Teacher, sender and classroom fields in the responses are never read.
- **`ical_feed`** — the school calendar's iCalendar feed over plain HTTP: no browser, no
  login, so it runs in CI. Get the URL from MyOS (Calendar > Options > WebCal Feed >
  **School Calendars**) and put it in `MYOS_CALENDAR_FEED_URL`; it holds a private token, so it
  is only ever read from the environment and is never published. `MYOS_CALENDAR_PAGE_URL` is
  the page the dashboard links to. **Special events only:** the calendar carries more than
  parents need, so a series (the same title repeated, or an RRULE), a class period, a
  practice or an athletic fixture is never published, and neither is anything cancelled or
  long past. Use the *School* calendars: a student's own Schedule feed is the daily timetable
  and names the child. An entry naming a configured child is withheld whole. Multi-day events
  carry an `end_date`, so a session inside the span is not mistaken for a conflict. The feed is a
  complete snapshot, so an event it stops reporting is removed.
- **`gmail`** — IMAP with an app password
  ([create one](https://myaccount.google.com/apppasswords); needs 2-Step
  Verification; never use the real account password). Reads newest-first within
  `lookbackDays`.
- **`school_portal`** — an authenticated portal page. Currently has no working
  source: it targets the old single-domain login form.
- **`website`, `calendar`, `pdf`, `google_doc`** — supported by the schema.
  `pdf` is not fetched (Playwright does not parse PDFs).

**`localOnly: true`** marks a source that needs an interactive login (the
newsletter board and both ClassDojo sources). Scheduled CI runs skip those
instead of failing.

## Privacy

Everything published goes to a **public URL**, so this is the core constraint.

- **Removed:** children's names (listed in `REDACT_NAMES`, because no pattern can
  safely infer a first name), other families' surnames, credential lines, email
  addresses, phone numbers.
- **Kept on purpose:** staff names. Stripping them made different teachers' rows
  indistinguishable.
- **Withheld whole, not redacted:** any message that names a child.
- **Email is broadcast-only.** A message is published only if it has a positive
  broadcast signal (`List-Unsubscribe`/`List-Id`/bulk precedence, undisclosed or
  zero visible recipients, a known mass-mail domain, or three or more
  addressees), no billing wording, no direct-message subject, no configured
  child name, and something school-actionable. Only derived signals are stored —
  never other recipients' addresses or message IDs. `broadcastChannel: true` is
  for a sender that *only* broadcasts (a school communications address); a class
  teacher must never have it.
- **Relevance is a privacy filter.** Under-publishing is recoverable;
  over-publishing to a public URL is not.
- The site sends `noindex` and a `robots.txt`. That is a request to crawlers,
  not access control.
- Real fetched content stays in gitignored `output/raw/`. Test fixtures are
  synthetic wherever they would contain names.

## Deployment (GitHub Pages + GitHub Actions)

`.github/workflows/update-dashboard.yml` runs weekly (Sunday 18:00 UTC) and on
manual dispatch. It type-checks, tests, runs the pipeline, validates, and
deploys `public/` plus `data/events.json` to Pages. Generated data is **not**
committed.

Because `events.json` is gitignored, a CI runner starts with no previous data.
The Newsletter and ClassDojo lanes need an interactive login, so CI skips them and
they have to be handed over from a local run (next section). Without that, they
would be empty on the live site.

### Publishing the lanes CI cannot fetch

After a local `npm run pipeline`:

```bash
npm run publish-data -- --dry-run   # validate and build the commit, push nothing
npm run publish-data              # push data/events.json to the `data` branch
```

The scheduled workflow restores that file before its own run, so the email lane is
refreshed on top of your latest local lanes. If there is no `data` branch yet, it
falls back to recovering from the live site via `DASHBOARD_URL`.

**The `data` branch is public.** It holds the same content as the Pages site. Every
publish force-pushes a fresh single-commit branch so snapshots do not pile up in
history, but GitHub can keep unreachable commits retrievable by SHA, and forks or
caches may hold copies. Treat anything you publish as permanently public.

**A failed run never replaces a good site with a broken one.** The pipeline step
is `continue-on-error`, so the validate and stage steps still run, and a final
step marks the run red. `events.json` is not committed, so if the pipeline fails
before writing it, validation fails, nothing is staged, and the existing
deployment stays live. If it got as far as writing valid data (recovered from
`DASHBOARD_URL` plus whatever sources succeeded), that is staged and deployed.
The `deploy` job uses `!cancelled()`, because GitHub otherwise skips a job whose
dependency failed.

Setup on a real repository:

1. **Settings → Pages → Source**: "GitHub Actions".
2. **Secrets** (Settings → Secrets and variables → Actions): `AI_PROVIDER`,
   `AI_API_KEY`, `AI_MODEL`, `GMAIL_ADDRESS`, `GMAIL_APP_PASSWORD`, and the
   `GMAIL_FILTER_*` names that `data/sources.json` references.
3. **Required for the email privacy filter:** `REDACT_NAMES` and
   `MAIL_BULK_DOMAINS`. Without them a scheduled run publishes more than a local
   run does. `SCHOOL_PORTAL_*` and `CLASSDOJO_*` are deliberately *not* needed in
   CI.
4. **Variable** (not a secret): `DASHBOARD_URL`, the public Pages URL.
5. Run the workflow once from the Actions tab to confirm it deploys.

## Reliability

- A failing source is logged and skipped; it never erases other sources' data.
- Empty extractions never overwrite good data.
- `validateData.ts` exits non-zero on schema errors or duplicate ids, so bad
  data cannot reach Pages.
- A conflict requires *different sources* disagreeing; one source reporting the
  same title on several dates is several occurrences.
- "Today" is derived in the school's time zone (`America/New_York`), never from
  UTC — after 8pm Eastern a UTC date is already tomorrow.

## Known gaps

- The Email lane's **School portal** section has no source.
- Link-preview (Open Graph) tags are not set, so a pasted link previews poorly.
- Events are removed only by the weekly-newsletter rule above; other sources
  accumulate until their events are in the past, and past events are filtered
  client-side.

## Cost

GitHub's free tier (Actions minutes, Pages) plus whatever the configured AI
provider charges for the rare fallback call. The default is the Gemini free
tier. No database, no paid hosting.
