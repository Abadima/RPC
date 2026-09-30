// The end-to-end check against a real Discord: the built Chromium extension
// (in playwright-core's isolated Chromium) on the real jena.systems,
// Parousia Desktop, and the Discord app running on this machine. It shows a
// real presence on the Discord account signed in there for HOLD_SECONDS (20
// by default), then clears it by closing the browser. So it never runs by
// accident, Discord's socket directory has to be named:
//
//   PAROUSIA_REAL_DISCORD_IPC_DIR="$XDG_RUNTIME_DIR" bun run discord:verify
//   Flatpak Discord: "$XDG_RUNTIME_DIR/app/com.discordapp.Discord"
//
// Linux; port 57179 must be free. Prerequisites: `bun run build` here,
// `cargo build` in ../desktop, `bun run chromium:setup` once.

import { chromium } from "playwright-core";
import { join } from "node:path";
import {
  QUIET_DISCORD,
  assert,
  browserDir,
  control,
  logger,
  popup,
  sleep,
  startDesktop,
  status,
  STEP_TIMEOUT_MS,
  waitUntil,
  workspace,
} from "./e2e/lib.mjs";

const discordDir = process.env.PAROUSIA_REAL_DISCORD_IPC_DIR;
if (!discordDir) {
  console.error(
    "discord:verify shows a real presence on your Discord. Name Discord's socket directory to run it:\n" +
      '  PAROUSIA_REAL_DISCORD_IPC_DIR="$XDG_RUNTIME_DIR" bun run discord:verify',
  );
  process.exit(2);
}
const HOLD_MS = Number(process.env.HOLD_SECONDS ?? 20) * 1000;

const log = logger("discord");
const extensionDir = join(browserDir, "dist", "chromium");
const discordStatus = async (ws) =>
  (await status(ws)).platforms.find((platform) => platform.platform === "discord");

const ws = await workspace("pdv", { discordDir });
let desktop;
let context;

try {
  desktop = startDesktop(ws);
  await desktop.waitFor(/listening on 127\.0\.0\.1:57179/);

  context = await chromium.launchPersistentContext(join(ws.dir, "profile"), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: STEP_TIMEOUT_MS }));
  await worker.evaluate(QUIET_DISCORD);
  const origin = `chrome-extension://${new URL(worker.url()).host}`;
  await control(ws, "allow", origin);
  const popupPage = await context.newPage();
  await popupPage.goto(`${origin}/popup.html`);
  await popup.waitForStatus(popupPage, /^Connected to Parousia Desktop$/);
  await popupPage.close();
  log(`Desktop running, this build (${origin}) allowed and connected`);

  const game = await context.newPage();
  await game.goto("https://jena.systems/apps/3851919");
  await game.bringToFront();
  const shown = await waitUntil(
    async () => {
      const adapter = await discordStatus(ws);
      assert(adapter?.state !== "refused", `Discord refused it: ${adapter?.error}`);
      return adapter?.state === "showing" ? adapter : false;
    },
    "Discord to show the activity",
    45_000,
  );
  await desktop.waitFor(/Discord: showing Jena Hub/);
  log(
    `Discord accepted it: showing ${shown.activity} ("Playing Chess", from the real jena.systems)`,
  );

  log(`holding it for ${HOLD_MS / 1000} s: check your Discord profile now`);
  await sleep(HOLD_MS);
  assert((await discordStatus(ws))?.state === "showing", "still showing after the hold");

  await context.close();
  context = undefined;
  const cleared = await waitUntil(async () => {
    const adapter = await discordStatus(ws);
    return adapter && adapter.state !== "showing" ? adapter : false;
  }, "Discord to clear it once the browser is gone");
  log(`browser closed: Discord cleared it (${cleared.state})`);
  log("done");
} catch (error) {
  console.error(`--- Desktop log ---\n${desktop?.lines.slice(-40).join("\n") ?? "(not started)"}`);
  throw error;
} finally {
  await context?.close().catch(() => {});
  await desktop?.stop();
  await ws.cleanup();
}
