// End-to-end check of the Browser <-> Desktop link with real processes: the
// built Parousia Desktop binary and the built dist/chromium extension in
// playwright-core's isolated Chromium (never a system browser profile). Runs
// in CI; `real:verify` covers installed browsers.
//
// Desktop runs against a throwaway data and runtime directory. Linux only;
// port 57179 must be free. Prerequisites: `bun run build` here, and
// `cargo build` in ../desktop.
//
// Covers: Desktop absent, then starting after the browser; an unrecognized
// build refused until it's allowed; two browsers at once; a detected
// Activity (Jena Hub, its page served by the test) reaching Discord through
// Desktop, following Settings > Platforms, and clearing when the browser
// disconnects; disallowing connected browsers; userscripts off by default,
// then opted in; hostile input straight to the socket; a second launch; the
// disconnected state when Desktop stops; and letting go when idle.
//
// "Discord" is a stand-in socket (e2e/fake-discord.mjs): Desktop is pointed
// at it and never at a real Discord.

import { chromium } from "playwright-core";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { startFakeDiscord } from "./e2e/fake-discord.mjs";
import { connectRaw } from "./e2e/raw-ws.mjs";
import {
  PAROUSIA_CLIENT_ID,
  QUIET_DISCORD,
  assert,
  browserDir,
  command,
  control,
  logger,
  popup,
  setDiscordPlatform,
  startDesktop,
  status,
  STEP_TIMEOUT_MS,
  waitUntil,
  workspace,
} from "./e2e/lib.mjs";

const log = logger("desktop-link");
const extensionDir = join(browserDir, "dist", "chromium");
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

async function launch(userDataDir) {
  // channel "chromium" runs the full build in new headless mode, which
  // (unlike the headless shell) can load extensions.
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: STEP_TIMEOUT_MS }));
  const id = new URL(worker.url()).host;
  await worker.evaluate(QUIET_DISCORD);
  return { context, worker, id, origin: `chrome-extension://${id}` };
}

async function openPopup(browser) {
  const page = await browser.context.newPage();
  await page.goto(`chrome-extension://${browser.id}/popup.html`);
  return page;
}

/** Closes a popup and opens a fresh one, which asks the background to check again. */
async function reopen(browser, page) {
  await page.close();
  return openPopup(browser);
}

const HELLO = JSON.stringify({ type: "hello", protocolVersion: 6, name: "Raw client" });
const JENA_GAME = "https://jena.systems/apps/3851919";

/** Opens a Jena Hub game page, served here with the real site's title (no network). */
async function openJenaGame(browser) {
  const page = await browser.context.newPage();
  await page.route("https://jena.systems/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Chess - Jena V3</title><p>Chess</p>",
    }),
  );
  await page.goto(JENA_GAME);
  return page;
}

const ws = await workspace("pdl");
const discord = await startFakeDiscord(ws.discordDir);
const profileA = join(ws.dir, "profile-a");
const profileB = join(ws.dir, "profile-b");
let desktop;
let a;
let b;

try {
  // --- Desktop absent, then starting after the browser ---
  a = await launch(profileA);
  let popupA = await openPopup(a);
  await popup.waitForStatus(popupA, /^Not connected to Parousia Desktop$/);
  assert(/Launch Parousia Desktop/.test(await popup.help(popupA)), "the popup says what to do");
  log(`Desktop absent: ${a.origin} reports "Not connected to Parousia Desktop" and how to fix it`);

  desktop = startDesktop(ws);
  await desktop.waitFor(/listening on 127\.0\.0\.1:57179/);
  await popup.waitForStatus(popupA, /^Not allowed by Parousia Desktop$/);
  assert(
    (await popup.help(popupA))?.includes(`Parousia-Desktop allow ${a.origin}`),
    "the popup names the exact command to allow this build",
  );
  await desktop.waitFor(new RegExp(`refused ${escape(a.origin)}: not an allowed Parousia build`));
  let report = await status(ws);
  assert(
    report.refused.length === 1 && report.refused[0].origin === a.origin,
    `Desktop lists the refused origin (${JSON.stringify(report.refused)})`,
  );
  assert(report.clients.length === 0, "and nothing connected");
  log(
    "Desktop started after the browser: picked up on the next retry; this unrecognized build is refused, listed, and told how to get allowed",
  );

  // --- Allowed: connects over the WebSocket ---
  let since = desktop.mark();
  report = await control(ws, "allow", a.origin);
  assert(report.settings.allowedOrigins.includes(a.origin), "allow updates the allowlist");
  const saved = JSON.parse(await readFile(join(ws.configDir, "config.json"), "utf8"));
  assert(saved.allowedOrigins.includes(a.origin), "and persists it to config.json");
  popupA = await reopen(a, popupA);
  await popup.waitForStatus(popupA, /^Connected to Parousia Desktop$/);
  await desktop.waitFor(new RegExp(`Chromium on Linux connected from ${escape(a.origin)}`), since);
  await desktop.waitFor(/presence from Chromium on Linux: none/, since);
  log("allowed from the CLI: connects, Presence arrives; saved to config.json");

  // --- A second browser, at the same time ---
  // Both profiles load the same unpacked dist/chromium directory, so
  // Chromium derives the same extension id for each: a real scenario (the
  // same build running in two browser profiles), and it shares one origin.
  b = await launch(profileB);
  let popupB = await openPopup(b);
  await popup.waitForStatus(popupB, /^Connected to Parousia Desktop$/);
  report = await status(ws);
  assert(report.clients.length === 2, `two clients (${report.clients.length})`);
  log("two browsers connected at once, sharing the one allowed build's origin");

  // --- Discord: a detected Activity, through Desktop ---
  const jenaPage = await openJenaGame(b);
  const shown = await discord.waitFor((a) => a?.details === "Playing Chess", "Playing Chess");
  assert(
    discord.handshakes.at(-1) === PAROUSIA_CLIENT_ID,
    `as Parousia's Discord Application (${discord.handshakes})`,
  );
  assert(
    shown.name === "Jena Hub" &&
      shown.state === "In the Arcade" &&
      shown.details_url === JENA_GAME &&
      shown.buttons?.[0]?.label === "Play Chess" &&
      shown.assets?.large_image === "https://jena.systems/icons/icon-512.png",
    `the whole activity arrives (${JSON.stringify(shown)})`,
  );
  report = await status(ws);
  const adapter = report.platforms.find((p) => p.platform === "discord");
  assert(
    adapter?.state === "showing" && adapter.activity === "Jena Hub",
    `Desktop reports it (${JSON.stringify(report.platforms)})`,
  );
  log('a Jena Hub game page is detected and Discord shows "Playing Chess" through Desktop');

  await b.worker.evaluate(setDiscordPlatform(false));
  await discord.waitFor((a) => a === null, "nothing once Discord is turned off");
  await b.worker.evaluate(setDiscordPlatform(true));
  await discord.waitFor((a) => a?.details === "Playing Chess", "it again once turned on");
  log("Settings > Platforms: turning Discord off clears it there, on shows it again");

  // --- Disallowing drops connected browsers ---
  await control(ws, "disallow", a.origin);
  await waitUntil(async () => (await status(ws)).clients.length === 0, "both to be dropped");
  await discord.waitFor((a) => a === null, "nothing once the browser is gone");
  popupA = await reopen(a, popupA);
  popupB = await reopen(b, popupB);
  await popup.waitForStatus(popupA, /^Not allowed by Parousia Desktop$/);
  await popup.waitForStatus(popupB, /^Not allowed by Parousia Desktop$/);
  await control(ws, "allow", a.origin);
  popupA = await reopen(a, popupA);
  popupB = await reopen(b, popupB);
  await popup.waitForStatus(popupA, /^Connected to Parousia Desktop$/);
  await popup.waitForStatus(popupB, /^Connected to Parousia Desktop$/);
  // The popups opened as tabs; the game's tab is the one being looked at again.
  await jenaPage.bringToFront();
  await discord.waitFor((a) => a?.details === "Playing Chess", "it again after reconnecting");
  log(
    "disallowed while connected: both dropped at once and refused, and Discord cleared; allowed again, both reconnect and Discord shows it again",
  );
  await jenaPage.close();
  await discord.waitFor((a) => a === null, "nothing once the page is closed");
  log("closing the page clears Discord");

  // --- Userscripts: off by default, then opted in ---
  for (const origin of [undefined, "null", "https://evil.example", "safari-web-extension://x"]) {
    const refused = await connectRaw({ origin });
    assert(refused.status === 403, `${origin} refused at the upgrade (${refused.status})`);
  }
  report = await control(ws, "set", "userscripts", "on");
  assert(report.settings.allowUserscripts, "userscripts turned on");
  const page = await connectRaw({ origin: "https://example.com" });
  assert(page.status === 101, "with userscripts on, a web origin gets through");
  page.sendText(HELLO);
  assert((await page.next())?.type === "welcome", "and is welcomed");
  page.sendText('{"type":"status"}');
  assert((await page.next())?.reason === "not_permitted", "but can't read Desktop's status");
  page.sendText('{"type":"set","setting":"allowUserscripts","value":false}');
  assert((await page.next())?.reason === "not_permitted", "or change its settings");
  await control(ws, "set", "userscripts", "off");
  assert((await page.next()) === null, "turning userscripts off drops it");
  assert(
    (await connectRaw({ origin: "https://example.com" })).status === 403,
    "and web origins get 403 again",
  );
  log(
    "web and invalid origins get a bare 403; with userscripts on, a page can publish Presence but not read status or change settings; off again, it's dropped",
  );

  // --- Hostile input straight to the socket ---
  const unknown = await connectRaw({
    origin: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba",
  });
  assert((await unknown.next())?.reason === "origin_not_allowed", "an unknown extension is told");
  assert((await unknown.next()) === null, "and closed before anything is read");
  // Any local process can claim an allowed origin (see project/threat-model.md).
  // Desktop must still hold up against whatever it sends.
  const old = await connectRaw({ origin: a.origin });
  old.sendText('{"type":"hello","protocolVersion":2,"clientId":"x","clientNonce":"y","proof":"z"}');
  assert((await old.next())?.reason === "unsupported_version", "a v2 hello: unsupported_version");
  const v4 = await connectRaw({ origin: a.origin });
  v4.sendText('{"type":"hello","protocolVersion":4,"name":"Phase 3 build"}');
  assert((await v4.next())?.reason === "unsupported_version", "a v4 hello: unsupported_version");
  // Protocol 5 sent each page's address along; since 6 it stays in the browser.
  const v5 = await connectRaw({ origin: a.origin });
  v5.sendText('{"type":"hello","protocolVersion":5,"name":"Sends page addresses"}');
  assert((await v5.next())?.reason === "unsupported_version", "a v5 hello: unsupported_version");
  for (const hostile of [
    "{not json",
    "[]",
    JSON.stringify({ type: "hello", protocolVersion: 6, name: "x", extra: true }),
    JSON.stringify({ type: "ping" }),
  ]) {
    const conn = await connectRaw({ origin: a.origin });
    conn.sendText(hostile);
    const reply = await conn.next();
    assert(reply?.reason === "malformed", `${hostile} rejected (${JSON.stringify(reply)})`);
    assert((await conn.next()) === null, `${hostile} closed`);
  }
  const huge = await connectRaw({ origin: a.origin });
  huge.sendBytes(huge.frame(Buffer.alloc(64 * 1024, 0x61)));
  assert((await huge.next()) === null, "an oversized frame closes the connection");
  const silent = await connectRaw({ origin: a.origin });
  assert((await silent.next(8000))?.reason === "timeout", "a silent client times out");
  const flood = await connectRaw({ origin: a.origin });
  flood.sendText(HELLO);
  for (let i = 0; i < 60; i++) flood.sendText('{"type":"ping"}');
  const replies = [];
  for (let reply = await flood.next(); reply; reply = await flood.next()) replies.push(reply);
  assert(replies.at(-1)?.reason === "rate_limited", "flooding: rate_limited, then closed");
  const health = await fetch("http://127.0.0.1:57179/health");
  assert(health.status === 200, "Desktop is still healthy");
  assert(
    (await popup.status(popupA))?.startsWith("Connected to Parousia Desktop"),
    "and real clients unaffected",
  );
  log(
    "hostile input: unknown extension told origin_not_allowed; v2, v4, v5, malformed, oversized, silent, and flooding connections are rejected and closed; Desktop stays up",
  );

  // --- A second launch ---
  const second = await command(ws, "--headless");
  assert(/already running/.test(second), `a second launch defers (${second.trim()})`);
  assert((await status(ws)).clients.length === 2, "and the first one is untouched");
  log("launching again reports the running Desktop and exits");

  // --- Desktop stops: clean disconnected state ---
  await desktop.stop();
  await popup.waitForStatus(popupA, /^Not connected to Parousia Desktop$/);
  await popup.waitForStatus(popupB, /^Not connected to Parousia Desktop$/);
  log("Desktop stopped: both browsers show a clean disconnected state");

  // --- Letting go when idle ---
  desktop = startDesktop(ws);
  await popup.waitForStatus(popupA, /^Connected to Parousia Desktop/);
  await popup.waitForStatus(popupB, /^Connected to Parousia Desktop/);
  await popupA.close();
  await popupB.close();
  await waitUntil(
    async () => (await status(ws)).clients.length === 0,
    "every connection to close once nothing needs Desktop",
    45_000,
  );
  log("with no popup open and nothing detected, both browsers let go after the linger period");

  log("done");
} catch (error) {
  console.error(`--- Desktop log ---\n${desktop?.lines.slice(-40).join("\n") ?? "(not started)"}`);
  throw error;
} finally {
  await a?.context.close().catch(() => {});
  await b?.context.close().catch(() => {});
  await desktop?.stop();
  await discord.stop();
  await ws.cleanup();
}
