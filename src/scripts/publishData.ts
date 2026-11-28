// Publishes this machine's data/events.json so the scheduled GitHub run can use it.
//
// Why this exists: the Newsletter and ClassDojo lanes need an interactive login,
// so CI cannot fetch them (they are localOnly). Their data is produced by a local
// `npm run pipeline`, and without a way to hand it to CI the live site never gets
// those lanes. events.json is gitignored on main on purpose, so this pushes it to
// a separate `data` branch instead; the workflow restores it before its own run.
//
// PRIVACY: the `data` branch is PUBLIC, like the Pages site that shows the same
// content. To avoid building up a browsable history of past snapshots, every
// publish is a brand-new single-commit branch that is force-pushed over the old
// one. That makes older snapshots unreachable from the branch, but GitHub can
// keep unreachable commits retrievable by SHA, and forks or caches may hold
// copies — so treat anything published here as permanently public.
//
// Run: npm run publish-data            (validate, then push)
//      npm run publish-data -- --dry-run   (validate and build the commit only)

import { execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventsDataSchema } from "../types/schema.js";
import { isMainModule } from "./runGuard.js";
import { validateEventsFile } from "./validateData.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const EVENTS_PATH = path.join(REPO_ROOT, "data/events.json");

/** The branch the workflow reads. Keep in sync with update-dashboard.yml. */
export const DATA_BRANCH = "data";

function git(workingDirectory: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: workingDirectory, encoding: "utf-8" }).trim();
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  // Never publish something the workflow would reject.
  await validateEventsFile(EVENTS_PATH);
  const data = EventsDataSchema.parse(JSON.parse(await readFile(EVENTS_PATH, "utf-8")));
  console.log(`Validated ${data.events.length} event(s), last updated ${data.last_updated}.`);

  const remoteUrl = git(REPO_ROOT, "remote", "get-url", "origin");
  const staging = await mkdtemp(path.join(tmpdir(), "school-dashboard-data-"));
  try {
    git(staging, "init", "-q", "-b", DATA_BRANCH);
    git(staging, "config", "user.name", git(REPO_ROOT, "config", "user.name"));
    git(staging, "config", "user.email", git(REPO_ROOT, "config", "user.email"));
    await copyFile(EVENTS_PATH, path.join(staging, "events.json"));
    git(staging, "add", "events.json");
    git(staging, "commit", "-q", "-m", "Publish local data snapshot");

    if (dryRun) {
      console.log(`Dry run: built a single commit for branch "${DATA_BRANCH}"; nothing was pushed.`);
      return;
    }

    git(staging, "remote", "add", "origin", remoteUrl);
    git(staging, "push", "--force", "-q", "origin", DATA_BRANCH);
    console.log(`Pushed to the "${DATA_BRANCH}" branch (public). The next workflow run will use it.`);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
