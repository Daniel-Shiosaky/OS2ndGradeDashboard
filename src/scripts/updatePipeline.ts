// Orchestrator: chains fetchSources -> processWithAi -> generateDashboard ->
// validateData with the section-26 style logging. This is the entry point
// the GitHub Actions workflow (and `npm run pipeline`) invokes.
//
// Reliability rules (project brief section 23) apply end to end: a failure
// at any step must not erase existing data or publish something unvalidated.
// If validation fails after generation, the job exits non-zero so CI fails
// loudly rather than deploying bad data.

import { fetchAllSources } from "./fetchSources.js";
import { processAllFetched } from "./processWithAi.js";
import { generateDashboard } from "./generateDashboard.js";
import { validateEventsFile } from "./validateData.js";
import { isMainModule } from "./runGuard.js";

async function main() {
  console.log("Fetching sources...");
  const fetchReport = await fetchAllSources();
  console.log(
    `Fetched ${fetchReport.fetched.length} source(s), ${fetchReport.failures.length} failure(s).`,
  );

  console.log("Processing source content...");
  const extractions = await processAllFetched();
  const totalEvents = extractions.reduce((sum, r) => sum + r.events.length, 0);
  console.log(`Events found: ${totalEvents}`);

  if (extractions.length === 0 && fetchReport.fetched.length > 0) {
    console.error("AI processing produced no results despite fetched content. Not publishing empty data.");
    process.exitCode = 1;
    return;
  }

  console.log("Generating dashboard...");
  try {
    await generateDashboard(extractions, process.env.DASHBOARD_URL);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Dashboard generation failed: ${message}`);
    console.error("Preserving previous valid data.");
    process.exitCode = 1;
    return;
  }

  console.log("Validating data...");
  try {
    await validateEventsFile();
    console.log("  OK   Validation successful");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`  FAIL Validation: ${message}`);
    process.exitCode = 1;
    return;
  }

  console.log("Deployment ready.");
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
