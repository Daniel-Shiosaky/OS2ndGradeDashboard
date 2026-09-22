# School Dashboard

A static parent dashboard that organizes school information (homework,
tests, events, deadlines, supplies, announcements) collected automatically
from configured school sources. Built to run at ~$0/month on GitHub Pages
and GitHub Actions, with no database.

The dashboard **organizes information, it does not invent it** — every
event carries a source, and the AI extraction step is instructed to omit
anything it can't confidently support from the source text. See
[`os2ndgrade_dashboard_POC.md`](../os2ndgrade_dashboard_POC.md) for the
full product spec, and [`AGENTS.md`](./AGENTS.md) for implementation notes
and current project status.

## How it works

```
Sources (website / calendar / PDF)
        │
        ▼  Playwright fetch, per-source, fails safely
   fetchSources.ts
        │
        ▼  AI extraction (organize, don't invent)
   processWithAi.ts
        │
        ▼  merge, conflict resolution, change log
   generateDashboard.ts  →  data/events.json, data/current-week.json,
        │                    output/whatsapp-message.txt
        ▼  schema + duplicate-id check
   validateData.ts
```

`src/scripts/updatePipeline.ts` chains all four steps and is what the
scheduled GitHub Actions workflow runs. The frontend
(`src/dashboard/app.ts`, bundled to `public/app.js`) reads
`data/events.json` client-side — there is no backend at request time.

## Local development

### 1. Install dependencies

```bash
npm install
npm run playwright:install   # downloads the Chromium binary fetchSources.ts uses
```

### 2. Run the dashboard (Phase 1 — no AI/backend needed)

The sample data in `data/events.json` is enough to see the full UI:

```bash
npm run dev
```

This builds the frontend bundle and starts a zero-dependency static file
server at `http://localhost:8080` (override with `PORT=...`). It serves
`public/` at `/` and `data/` at `/data/`, matching how the deployed site
is laid out.

### 3. Configure local credentials (only needed for the AI pipeline)

```bash
cp .env.example .env
```

Fill in `AI_API_KEY` (and `AI_PROVIDER`/`AI_MODEL` if you're not using the
defaults). `.env` is gitignored and **must never be committed** — it's
local-dev only. In GitHub Actions, the same variable names are provided as
repository secrets instead (see below).

### 4. Configure sources

Edit `data/sources.json` — add/remove/enable sources without touching any
code. `priority` (lower number = higher priority) controls which source
wins when two sources report conflicting information for the same event.

### 5. Run the pipeline steps

Each step can run standalone, or all together:

```bash
npm run fetch-sources     # Playwright fetch → output/raw/<slug>.json
npm run process-ai        # AI extraction → data/pending-review.json
npm run generate-dashboard  # merge + conflict resolution → data/events.json
npm run validate-data      # schema + duplicate-id check, exits non-zero on failure
npm run pipeline           # all of the above, in order
```

`fetchSources.ts` currently skips `type: "pdf"` sources — Playwright
navigates pages, it doesn't parse PDFs. The sample `Weekly Newsletter`
source is disabled by default for this reason.

## Tests

```bash
npm test
```

Covers week-range math, event merge/conflict resolution, schema
validation (including duplicate-id detection), and AI response JSON
parsing, using fixture data — no live sources or AI API required.

## Deployment (GitHub Pages + GitHub Actions)

`.github/workflows/update-dashboard.yml` runs on a weekly cron (Sunday
18:00 UTC) and via manual `workflow_dispatch`. It type-checks, tests,
runs the full pipeline, commits `data/events.json` /
`data/current-week.json` / `output/whatsapp-message.txt` if they changed,
and deploys `public/` (with a copy of the current data) to GitHub Pages.

To enable it on a real repository:

1. **Settings → Pages → Source**: set to "GitHub Actions".
2. **Settings → Secrets and variables → Actions → New repository secret**:
   add `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` (and optionally
   `AI_TIMEOUT_MS`). These map 1:1 to the names in `.env.example` — never
   put real keys in a committed file.
3. Optional: add an Actions **variable** (not secret) `DASHBOARD_URL` —
   the public URL used in the generated WhatsApp message. Defaults to a
   placeholder if unset.
4. Trigger the workflow manually once (Actions tab → Update Dashboard →
   Run workflow) to confirm it deploys.

## Reliability

- A source that fails to fetch is logged and skipped — it never erases
  existing data for other sources.
- If AI processing produces no results, the pipeline does not publish
  empty data; the previous valid `data/events.json` is left in place.
- `validateData.ts` fails the job (non-zero exit) on schema errors or
  duplicate event ids, so bad data never reaches Pages.
- Cross-source conflicts (same event, different reported dates) are
  resolved by source `priority` and logged as `CONFLICT`, never silently
  dropped.

## Cost

Everything here runs on GitHub's free tier (Actions minutes for a public
repo, Pages hosting) plus whatever the configured AI provider charges per
API call. No database, no paid hosting.
