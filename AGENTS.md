# AGENTS.md — Context for resuming this project

This file exists so a fresh Claude Code session (e.g. opened directly in
VS Code) can pick up exactly where the previous session left off, without
re-deriving decisions already made.

The original product spec this project is based on lives at:
`C:\Users\Daniel\Documents\POC\os2ndgrade_dashboard_POC.md`
Read it first — it is the source of truth for product intent, phases,
data model, categories, and the "organize, don't invent" principle.

## Deviations from the original spec (explicitly requested by the user)

The base spec allowed either Python or Node for automation and plain
JS for the frontend. The user overrode these specifics:

1. **TypeScript everywhere**, not JavaScript. Backend scripts run via `tsx`
   (no separate compile step needed for scripts); the frontend is written
   in TS under `src/dashboard/` and bundled to `public/app.js` with esbuild.
2. **Playwright** is used for source fetching/browser navigation (handles
   JS-rendered school websites/calendars), not a plain HTTP fetch + HTML
   parser.
3. **`.env` for local credentials**, gitignored. GitHub Actions uses repo
   secrets (same variable names) instead of the file — `.env` is local-dev
   only and must never be committed. `.env.example` documents the shape and
   is the only one committed.

Everything else (JSON data files, GitHub Pages hosting, $0/month target,
no database, source-attribution requirement, fail-safe reliability rules)
follows the original spec as written.

## Status: what exists right now

```
school-dashboard/
├── .env                      # local secrets, gitignored, placeholder values only
├── .env.example              # committed template — AI_PROVIDER/AI_API_KEY/AI_MODEL/AI_TIMEOUT_MS
├── .gitignore                # excludes .env, node_modules, public/app.js (build output), output/raw/
├── README.md                 # setup/run/deploy instructions
├── package.json              # scripts + deps (playwright, zod, tsx, esbuild, typescript, vitest)
├── tsconfig.json             # strict TS, noEmit (tsc used for typecheck only; tsx/esbuild do the running)
├── .github/workflows/
│   └── update-dashboard.yml  # weekly Sunday cron + workflow_dispatch: typecheck, test, pipeline,
│                             #   commit changed data, deploy public/ (+ data snapshot) to GitHub Pages
├── data/
│   ├── sources.json          # sample source config (school website/calendar/newsletter PDF)
│   └── events.json           # realistic sample events for local dev (Phase 1 needs no backend)
├── public/
│   ├── index.html            # This Week / Upcoming / Important / Supplies / Announcements / Sources + search
│   ├── styles.css            # mobile-first, light/dark via prefers-color-scheme
│   └── app.js                # build output (gitignored), produced by `npm run build:frontend`
├── tests/                    # vitest — weekRange, mergeEvents, validateData, extractJson (26 tests, all passing)
│   └── fixtures/             # valid / invalid-schema / duplicate-id events.json fixtures
└── src/
    ├── dashboard/app.ts      # frontend: fetches data/events.json client-side, renders sections + search
    ├── types/schema.ts       # zod schemas + TS types: SchoolEvent, EventsData, SourcesConfig, etc.
    ├── shared/weekRange.ts   # isomorphic (no Node APIs) Sun–Sat week-range math, used by frontend + backend
    └── scripts/
        ├── runGuard.ts       # isMainModule() helper (Windows-safe "run if invoked directly" check)
        ├── aiProvider.ts     # AI_PROVIDER-driven abstraction; Anthropic + OpenAI implementations via fetch()
        ├── fetchSources.ts   # Playwright chromium fetch per enabled source, fails safely per-source,
        │                     #   writes output/raw/<slug>.json; PDF-type sources are skipped (not yet handled)
        ├── processWithAi.ts  # reads output/raw/*.json, prompts AI per source (section 14 rules),
        │                     #   validates response with ExtractionResultSchema, writes data/pending-review.json
        │                     #   (extractJson() is exported for testing)
        ├── generateDashboard.ts  # merges pending extractions into data/events.json, cross-source
        │                     #   conflict resolution by source priority, change log (new/changed/removed),
        │                     #   writes data/current-week.json + output/whatsapp-message.txt
        ├── validateData.ts   # standalone schema + duplicate-id validation, exits non-zero on failure
        ├── updatePipeline.ts # orchestrator: fetchSources → processWithAi → generateDashboard → validateData
        └── devServer.ts      # zero-dependency static server for `npm run dev` (serves public/ at "/",
                              #   data/ at "/data/" — same layout the deployed site uses)
```

`npm install` has been run — `node_modules/` exists. `npx playwright
install chromium` has been run (browser binary present, no system deps
installed via `--with-deps` since this is a Windows dev machine — CI
installs its own via `npm run playwright:install` which includes
`--with-deps`).

Verified this session: `npm run typecheck` clean, `npm test` (26/26
passing), `npm run build:frontend` succeeds, and the dashboard was
driven end-to-end in headless Chromium against `npm run dev` — sections
populate from the sample data, search filters correctly, zero console
errors. Screenshots were taken but not saved into the repo.

## Not started yet (next steps, roughly in order)

1. **Live pipeline run** — `npm run pipeline` has not been run against
   real data. `data/sources.json` still points at `example.com`
   placeholders, so a real run needs real source URLs plus a real
   `AI_API_KEY` in `.env` to do anything meaningful. Fine for now since
   Phase 1 (the static dashboard) doesn't depend on it.
2. **PDF sources** — `fetchSources.ts` still skips `type: "pdf"` entirely;
   no text-extraction step exists yet. Flag this if the user enables the
   sample `Weekly Newsletter` PDF source.
3. **Phase 5 — AI question box** (spec section 18) — not started. Needs a
   secure server-side path (can't call the AI API with a browser-exposed
   key); likely another GitHub Actions-triggered or serverless endpoint.
   Not attempted yet since Phases 1–4 (dashboard, automated data,
   deployment, WhatsApp summary) come first per the spec's phase order.
4. **GitHub Pages not yet enabled on an actual repo** — the workflow is
   written and typechecked as YAML-adjacent (not validated by GitHub
   Actions itself, since there is no `git` repo / remote wired up for
   *this* project yet — see note below). Someone needs to push this to
   a real GitHub repo, set Pages source to "GitHub Actions", and add the
   `AI_PROVIDER`/`AI_API_KEY`/`AI_MODEL` secrets before the workflow can
   run for real.
5. Empty placeholder directories still empty: `sources/` (README.md for
   it was never called for in the plan — low priority, spec section 6
   only used it as an example of "no hardcoded URLs" convention, and
   `data/sources.json` already fulfills that).

## Important: no git repo wired up for this project yet

`school-dashboard/` itself is **not** a git repository (no `.git/` here).
There is a sibling directory, `OS2ndGradeDashboard/`, which **is** an
empty git repo with `origin` set to
`https://github.com/Daniel-Shiosaky/OS2ndGradeDashboard.git` — presumably
intended as the eventual home for this project, but nothing has been
copied into it yet. Before the GitHub Actions workflow can run for real,
someone needs to decide: turn `school-dashboard/` into the git repo
directly (`git init` here, add that remote), or move/copy this content
into `OS2ndGradeDashboard/`. Don't assume which one — ask.

## Design notes worth knowing before continuing

- **Event id scheme**: `${slugify(title)}-${date}`. `generateDashboard.ts`
  matches incoming AI extractions against existing events by this id to
  detect new vs. changed vs. removed.
- **Conflict resolution**: when two different sources report the same
  normalized title with different dates, `mergeEvents()` in
  `generateDashboard.ts` picks the entry from the source with the lower
  `priority` number in `data/sources.json` (1 = highest) and logs a
  `CONFLICT` line rather than silently dropping either value, per spec
  section 13.
- **PDF sources**: `fetchSources.ts` currently skips `type: "pdf"` sources
  entirely (Playwright navigates pages, it doesn't parse PDFs). A PDF
  text-extraction step is not implemented yet — flag this to the user if
  they enable the sample `Weekly Newsletter` PDF source.
- **AI provider swap**: `getAiProvider()` in `aiProvider.ts` switches on
  `AI_PROVIDER` (`anthropic` | `openai`). Both call raw `fetch()` against
  the provider's REST API — no SDK dependency, per the "avoid unnecessary
  dependencies" rule in the spec.
