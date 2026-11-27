// One-time (and occasional) interactive portal login.
//
// Opens a visible browser on the saved portal profile, fills the username and
// password, and waits while you type the 6-digit code the portal emails to the
// account. Once that succeeds the profile is remembered, so the scheduled/local
// pipeline can reuse the session headlessly without another code.
//
// Run: npm run portal-login

import { ensurePortalSession, launchPortalContext, PORTAL_PROFILE_DIR } from "./fetchSources.js";
import { isMainModule } from "./runGuard.js";

async function main() {
  const loginUrl = process.env.SCHOOL_PORTAL_LOGIN_URL;
  const username = process.env.SCHOOL_PORTAL_USERNAME;
  const password = process.env.SCHOOL_PORTAL_PASSWORD;
  const probeUrl = process.env.SCHOOL_PORTAL_BULLETIN_URL ?? loginUrl;
  if (!loginUrl || !username || !password || !probeUrl) {
    console.error("SCHOOL_PORTAL_LOGIN_URL / SCHOOL_PORTAL_USERNAME / SCHOOL_PORTAL_PASSWORD must be set in .env");
    process.exitCode = 1;
    return;
  }

  const context = await launchPortalContext({ headless: false });
  try {
    console.log("A browser window is open. If the portal asks for a 6-digit code, type it in that window.");
    console.log("You have 5 minutes.");
    await ensurePortalSession(context, { loginUrl, username, password }, probeUrl, { interactive: true });
    console.log(`Signed in. Session saved to ${PORTAL_PROFILE_DIR}`);
  } catch (err) {
    const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
    console.error(`Portal login did not complete: ${message}`);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
