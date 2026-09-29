// Runtime-verifies dist/firefox/ in a real, isolated Firefox engine, beyond
// a successful build. Two checks, each catching what a build alone can't:
//
//   1. `web-ext lint`: static manifest/API validation against Firefox's own
//      rules (deprecated keys, AMO requirements, etc).
//   2. `web-ext run` against a real Firefox binary, installed as a temporary
//      add-on over the Remote Debugging Protocol: this is Firefox's own
//      manifest/extension acceptance, not just JSON validation.
//
// Firefox is playwright-core's isolated, automation-only binary (`bun run
// firefox:setup` downloads it once), never a system Firefox, which could be
// someone's actual browser session.
//
// Known gap: neither WebDriver BiDi nor web-ext's RDP client currently
// surfaces a WebExtension background page's own console output (confirmed
// by hand: BiDi's log.entryAdded never fires for it, and BiDi explicitly
// refuses to navigate a browsing context to a moz-extension:// URL at all).
// So this can't watch background.ts's own console the way the Chromium
// bundle test does for the service worker. background.ts's setup logic is
// still covered by chromium.bundle.test.ts (same source, same `chrome.*`
// calls); this script instead confirms Firefox's own engine accepts the
// packaged extension as valid, which a unit test can't.

import { firefox } from "playwright-core";
import webExt from "web-ext";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const browserDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = join(browserDir, "dist", "firefox");

async function lint() {
  console.log("[verify-firefox] linting manifest/API usage...");
  const result = await webExt.cmd.lint(
    { sourceDir, selfHosted: true, pretty: false },
    { shouldExitProgram: false },
  );
  if (result.summary.errors > 0) {
    console.error(JSON.stringify(result, null, 2));
    throw new Error(`web-ext lint found ${result.summary.errors} error(s)`);
  }
  console.log(
    `[verify-firefox] lint clean (${result.summary.warnings} warning(s), ${result.summary.notices} notice(s))`,
  );
}

async function runInFirefox() {
  const firefoxBinary = firefox.executablePath();
  console.log(`[verify-firefox] launching isolated Firefox: ${firefoxBinary}`);

  const profileDir = await mkdtemp(join(tmpdir(), "parousia-firefox-verify-"));
  let runner;
  try {
    runner = await webExt.cmd.run(
      {
        sourceDir,
        firefox: firefoxBinary,
        firefoxProfile: profileDir,
        profileCreateIfMissing: true,
        keepProfileChanges: false,
        noInput: true,
        noReload: true,
        args: ["--headless"],
      },
      { shouldExitProgram: false },
    );

    // The temporary-addon install call inside `run` already throws on
    // failure; this just gives Firefox a moment to prove it's still alive
    // (no crash/exit) with the extension loaded before we tear down.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    console.log("[verify-firefox] installed and running in real Firefox, no crash");
  } finally {
    await runner?.exit();
    await rm(profileDir, { recursive: true, force: true });
  }
}

await lint();
await runInFirefox();
console.log("[verify-firefox] done");
