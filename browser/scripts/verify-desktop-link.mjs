// End-to-end check of the Browser <-> Desktop link with real processes: the
// built Parousia Desktop binary and the built dist/chromium extension in
// playwright-core's isolated Chromium (never a system browser profile). Runs
// in CI; `real:verify` covers installed browsers.
//
// Desktop runs against a throwaway data and runtime directory. Linux and Windows;
// port 57179 must be free. Prerequisites: `bun run build` here, and
// `cargo build` in ../desktop.
//
// Covers: Desktop absent, then starting after the browser; an unrecognized
// build refused until it's allowed; two browsers at once; a detected
// Activity (Abadima's Portfolio, its page served by the test) reaching Discord through
// Desktop, following Settings > Platforms, and clearing when the browser
// disconnects; disallowing connected browsers; userscripts off by default,
// then opted in; hostile input straight to the socket; a second launch; the
// disconnected state when Desktop stops; and letting go when idle.
//
// "Discord" is a stand-in socket (e2e/fake-discord.mjs): Desktop is pointed
// at it and never at a real Discord.

import { chromium } from "playwright-core";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
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
  sleep,
  startDesktop,
  status,
  STEP_TIMEOUT_MS,
  waitUntil,
  windows,
  workspace,
} from "./e2e/lib.mjs";

const log = logger("desktop-link");
/** What Desktop calls this OS in a browser's name ("Chromium on Linux"). */
const os = windows ? "Windows" : "Linux";
const extensionDir = resolve(browserDir, process.env.PAROUSIA_BUILD_DIR ?? "dist", "chromium");
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

async function launch(userDataDir, dir = extensionDir) {
  // channel "chromium" runs the full build in new headless mode, which
  // (unlike the headless shell) can load extensions.
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
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

const HELLO = JSON.stringify({
  type: "hello",
  protocolVersion: 1,
  version: "1.0.0",
  name: "Raw client",
});
const PORTFOLIO_PAGE = "https://abadima.dev/pages/projects";

/** Opens a portfolio page (a native Activity that reads only the address and title, so it needs no page data), served here (no network). */
async function openPortfolioPage(browser) {
  const page = await browser.context.newPage();
  await page.route("https://abadima.dev/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Projects - Abadima</title><p>Projects</p>",
    }),
  );
  await page.goto(PORTFOLIO_PAGE);
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
  await desktop.waitFor(new RegExp(`Chromium on ${os} connected from ${escape(a.origin)}`), since);
  await desktop.waitFor(new RegExp(`presence from Chromium on ${os}: none`), since);
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

  // --- Versions: another minor keeps working; "update Desktop" is only said when GitHub lists a newer one ---
  // Copies of the build with another version, each its own extension (and origin).
  // Desktop and the extension version on their own, so each case is Desktop's
  // own version, a minor above it, and the next major. GitHub is answered here
  // (the run has no network), with the release notes the workflow writes.
  const [major, minor, patch] = (
    await readFile(join(browserDir, "..", "desktop", "Cargo.toml"), "utf8")
  )
    .match(/^version = "(\d+)\.(\d+)\.(\d+)/m)
    .slice(1)
    .map(Number);
  const desktopVersion = `${major}.${minor}.${patch}`;
  const releaseNotes = (version) =>
    JSON.stringify({
      tag_name: "v9.9.9",
      body: `Notes\n\n<!-- parousia-desktop: ${version} -->\n`,
    });
  const notice = (page) =>
    page.$eval("#update-notice", (el) => (el.hidden ? null : el.textContent));
  const github = {
    // The release that carries this very Desktop: a newer extension is not news.
    current: (route) => route.fulfill({ status: 200, body: releaseNotes(desktopVersion) }),
    newer: (route) =>
      route.fulfill({ status: 200, body: releaseNotes(`${major}.${minor}.${patch + 1}`) }),
    unreachable: (route) => route.abort(),
    nothing: (route) => route.fulfill({ status: 200, body: JSON.stringify({ body: "no marker" }) }),
  };
  for (const [version, expectation, answer] of [
    [desktopVersion, "level", "current"],
    [`${major}.${minor + 1}.0`, "quiet", "current"],
    [`${major}.${minor + 1}.0`, "quiet", "unreachable"],
    [`${major}.${minor + 1}.0`, "quiet", "nothing"],
    [`${major}.${minor + 1}.0`, /A newer Parousia Desktop is available/, "newer"],
    [`${major + 1}.0.0`, null, "current"],
  ]) {
    const label = `${version} with GitHub ${answer}`;
    const dir = join(ws.dir, `extension-${version}-${answer}`);
    await cp(extensionDir, dir, { recursive: true });
    const manifestPath = join(dir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version }));
    const other = await launch(join(ws.dir, `profile-${version}-${answer}`), dir);
    const asked = [];
    await other.context.route("https://api.github.com/**", (route) => {
      asked.push(route.request());
      return github[answer](route);
    });
    await control(ws, "allow", other.origin);
    let page = await openPopup(other);
    if (expectation === "level" || expectation === "quiet") {
      await popup.waitForStatus(page, /^Connected to Parousia Desktop/);
      if (expectation === "quiet") {
        await waitUntil(async () => asked.length > 0, `${label}: the lookup`);
      }
      await sleep(500);
      assert((await notice(page)) === null, `${label}: no update notice`);
      if (expectation === "level") assert(asked.length === 0, `${label}: GitHub is not asked`);
    } else if (expectation) {
      await popup.waitForStatus(page, /^Connected to Parousia Desktop/);
      await waitUntil(async () => (await notice(page)) !== null, "the update notice");
      assert(expectation.test(await notice(page)), `v${version}: ${await notice(page)}`);
      assert(
        (await page.textContent("#update-notice a")) === "Update Parousia Desktop",
        "with the download",
      );
      const request = asked[0];
      assert(
        request?.url() === "https://api.github.com/repos/Abadima/RPC/releases/latest",
        `asked ${request?.url()}`,
      );
      const headers = await request.allHeaders();
      assert(
        !headers.cookie && !headers.authorization,
        "the request carries no cookie or credentials",
      );
      await page.click("#update-notice button");
      assert((await notice(page)) === null, "Not now hides it");
      page = await reopen(other, page);
      await popup.waitForStatus(page, /^Connected to Parousia Desktop/);
      await sleep(300);
      assert((await notice(page)) === null, "and it stays hidden when the popup opens again");
      assert(asked.length === 1, `the answer is remembered (${asked.length} requests)`);
    } else {
      await popup.waitForStatus(page, /^Parousia Desktop version mismatch$/);
      assert(/Versions don't match/.test(await popup.help(page)), "another major is refused");
      assert((await notice(page)) === null, "with no update notice");
      assert(asked.length === 0, "and GitHub is not asked");
    }
    await other.context.close();
  }
  await waitUntil(async () => (await status(ws)).clients.length === 2, "the extra browsers to go");
  log(
    "versions: a newer extension connects quietly unless GitHub lists a newer Desktop (current, unreachable, or unreadable answers say nothing; the answer is remembered; no cookies sent); another major version is refused as a mismatch",
  );

  // --- Discord: a detected Activity, through Desktop ---
  const portfolioPage = await openPortfolioPage(b);
  const shown = await discord.waitFor(
    (a) => a?.details === "Browsing projects",
    "Browsing projects",
  );
  assert(
    discord.handshakes.at(-1) === PAROUSIA_CLIENT_ID,
    `as Parousia's Discord Application (${discord.handshakes})`,
  );
  assert(
    shown.name === "Abadima" &&
      shown.state === "Exploring the portfolio" &&
      shown.details_url === PORTFOLIO_PAGE &&
      shown.buttons?.[0]?.label === "Open Abadima's Portfolio" &&
      shown.assets?.large_image === "https://abadima.dev/assets/imgs/abadima_fav.ico",
    `the whole activity arrives (${JSON.stringify(shown)})`,
  );
  report = await status(ws);
  const adapter = report.platforms.find((p) => p.platform === "discord");
  assert(
    adapter?.state === "showing" && adapter.activity === "Abadima",
    `Desktop reports it (${JSON.stringify(report.platforms)})`,
  );
  log('an abadima.dev page is detected and Discord shows "Browsing projects" through Desktop');

  await b.worker.evaluate(setDiscordPlatform(false));
  await discord.waitFor((a) => a === null, "nothing once Discord is turned off");
  await b.worker.evaluate(setDiscordPlatform(true));
  await discord.waitFor((a) => a?.details === "Browsing projects", "it again once turned on");
  log("Settings > Platforms: turning Discord off clears it there, on shows it again");

  // --- Discord quitting and starting again ---
  const quitAt = Date.now();
  await discord.quit();
  await waitUntil(
    async () => (await status(ws)).platforms[0]?.state === "not_running",
    "Desktop to notice Discord quit",
    3000,
  );
  assert(
    Date.now() - quitAt < 3000,
    `Discord quitting is noticed at once, not at the next update (${Date.now() - quitAt} ms)`,
  );
  const shownBefore = discord.activities.length;
  const connectionsBefore = discord.handshakes.length;
  await discord.reopen();
  await waitUntil(
    () => discord.activities.length > shownBefore,
    "it to be shown again once Discord is back",
  );
  assert(discord.activities.at(-1)?.details === "Browsing projects", "the same Activity");
  assert(
    discord.handshakes.length === connectionsBefore + 1 &&
      discord.handshakes.at(-1) === PAROUSIA_CLIENT_ID,
    `on a new connection (${discord.handshakes})`,
  );
  assert((await status(ws)).platforms[0]?.state === "showing", "and Desktop says it's showing");
  log(
    "Discord quits and starts again: noticed at once, and the Activity is shown again on a new connection",
  );

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
  await portfolioPage.bringToFront();
  await discord.waitFor((a) => a?.details === "Browsing projects", "it again after reconnecting");
  log(
    "disallowed while connected: both dropped at once and refused, and Discord cleared; allowed again, both reconnect and Discord shows it again",
  );
  await portfolioPage.close();
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
  for (const [label, hello] of [
    ["another protocol", { protocolVersion: 2, version: "1.0.0", name: "x" }],
    ["another major", { protocolVersion: 1, version: "2.0.0", name: "x" }],
    ["no version", { protocolVersion: 1, name: "x" }],
  ]) {
    const conn = await connectRaw({ origin: a.origin });
    conn.sendText(JSON.stringify({ type: "hello", ...hello }));
    assert((await conn.next())?.reason === "unsupported_version", `${label}: unsupported_version`);
  }
  // Another minor, patch, or beta is welcome: the extension tells its user to update.
  const newer = await connectRaw({ origin: a.origin });
  newer.sendText(
    JSON.stringify({ type: "hello", protocolVersion: 1, version: "1.9.0-beta.3", name: "Newer" }),
  );
  assert((await newer.next())?.type === "welcome", "another minor and beta: welcome");
  newer.close();
  for (const hostile of [
    "{not json",
    "[]",
    JSON.stringify({ type: "hello", protocolVersion: 1, version: "1.0.0", name: "x", extra: true }),
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
    "hostile input: unknown extension told origin_not_allowed; another protocol or major version, malformed, oversized, silent, and flooding connections are rejected and closed; Desktop stays up",
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
