// End-to-end check of Activities in the Firefox installed on this machine
// (Developer Edition, over WebDriver BiDi; see e2e/firefox.mjs), with the
// Parousia Desktop debug build and a stand-in Discord. The Chromium side of
// the same features is `activities:verify`.
//
// Covers, in Firefox: a real, unmodified PreMiD Activity reaching Discord
// through Desktop as its own Application; the extension's storage out of
// reach of the world PreMiD's code runs in (Firefox can't restrict content
// scripts' storage the way Chromium does, so the runtime takes it away); an
// Activity that's on without its site unavailable, and the popup saying why;
// and the Default Activity, written in the dashboard and shown where no
// Activity is.
//
// BiDi can't intercept requests, so pages come from a local HTTP proxy that
// answers for any host, and the build's manifest holds DiscordJS Guide's
// site as granted (Firefox grants an MV3 build's host permissions when it's
// installed); Jummbox's deliberately isn't.
//
// Prerequisites: `bun run activities:fetch`, `cargo build` in ../desktop, and
// Firefox Developer Edition at /opt/firefox (or FIREFOX_BIN). Linux only;
// port 57179 must be free.

import { execFile } from "node:child_process";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { startFakeDiscord } from "./e2e/fake-discord.mjs";
import { FIREFOX_BINARY, launchFirefox, prepareProfile } from "./e2e/firefox.mjs";
import {
  assert,
  browserDir,
  control,
  logger,
  startDesktop,
  waitUntil,
  workspace,
} from "./e2e/lib.mjs";

const log = logger("activities-firefox");
const run = promisify(execFile);

const PAROUSIA_ID = "parousia@abadima.dev";
const PAROUSIA_UUID = "8d7c6b5a-4e3f-4a2b-9c1d-0e1f2a3b4c5d";
const EXTENSION = `moz-extension://${PAROUSIA_UUID}`;
const GUIDE = "premid:DiscordJS Guide";
const GUIDE_CLIENT = "819865300173324288";
const JUMMBOX = "premid:Jummbox";

/** What the proxy answers for each host; anything else gets an empty page. */
const PAGES = {
  "discordjs.guide":
    "<!doctype html><title>Slash commands | discord.js Guide</title><h1>Slash Commands</h1>",
  "jummb.us": "<!doctype html><title>JummBox</title><p>Beep</p>",
  "nothing.example": "<!doctype html><title>Nothing</title><p>No Activity here.</p>",
};

const ws = await workspace("pavf");
const discord = await startFakeDiscord(ws.discordDir);
const shown = (check, description) => discord.waitFor(check, description);
let desktop;
let firefox;
let proxy;

try {
  // --- A build of its own, DiscordJS Guide's site granted ---
  const dist = join(ws.dir, "dist");
  await run("bun", ["run", "build.ts"], {
    cwd: browserDir,
    env: {
      ...process.env,
      PAROUSIA_ACTIVITIES_DIR: join(browserDir, "scripts", "activities", "fixtures", "parousia"),
      PAROUSIA_BUILD_DIR: dist,
    },
  });
  const manifestPath = join(dist, "firefox", "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.permissions = [...manifest.permissions, "scripting"];
  manifest.host_permissions = ["*://discordjs.guide/*"];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  const xpi = join(ws.dir, "parousia.xpi");
  await run(
    "bun",
    [
      "-e",
      `import { writeZip } from "./scripts/zip.ts"; await writeZip(${JSON.stringify(join(dist, "firefox"))}, ${JSON.stringify(xpi)});`,
    ],
    { cwd: browserDir },
  );

  // --- Pages, from a proxy that answers for any host ---
  proxy = createServer((request, response) => {
    const host = new URL(request.url ?? "/", "http://unknown").hostname;
    response.writeHead(200, { "content-type": "text/html" });
    response.end(PAGES[host] ?? "<!doctype html><title>Empty</title>");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = proxy.address().port;

  // --- Desktop, and Firefox ---
  desktop = startDesktop(ws);
  await desktop.waitFor(/listening on 127\.0\.0\.1:57179/);
  const profileDir = join(ws.dir, "firefox");
  await prepareProfile(profileDir, [{ id: PAROUSIA_ID, xpi, uuid: PAROUSIA_UUID }]);
  await appendFile(
    join(profileDir, "user.js"),
    `\n${Object.entries({
      "network.proxy.type": 1,
      "network.proxy.http": "127.0.0.1",
      "network.proxy.http_port": proxyPort,
      "network.proxy.share_proxy_settings": false,
      "dom.security.https_first": false,
      "dom.security.https_only_mode": false,
    })
      .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`)
      .join("\n")}\n`,
  );
  // Its origin is fixed (extensions.webextensions.uuids), so it's allowed before Firefox starts.
  await control(ws, "allow", EXTENSION);
  firefox = await launchFirefox({ profileDir, env: ws.env });
  const version = (await run(FIREFOX_BINARY, ["--version"])).stdout.trim();
  const ext = await firefox.openTab(`${EXTENSION}/fullscreen.html#activities`);
  await firefox.evaluate(
    ext,
    `browser.storage.local.set({
      preferences: { discordRpcExtension: false },
      activities: { ${JSON.stringify(GUIDE)}: { on: true }, ${JSON.stringify(JUMMBOX)}: { on: true } },
    })`,
  );
  const origins = await firefox.evaluate(
    ext,
    "browser.permissions.getAll().then((p) => p.origins)",
  );
  assert(
    origins.includes("*://discordjs.guide/*"),
    `DiscordJS Guide's site is granted (${origins})`,
  );
  assert(!origins.some((origin) => origin.includes("jummb.us")), "Jummbox's isn't");
  log(`${version}: built with DiscordJS Guide's site granted and Jummbox's not; both turned on`);

  // --- PreMiD's code in a Firefox page ---
  const guide = await firefox.openTab("http://discordjs.guide/creating-your-bot/slash-commands");
  const first = await shown(
    (a) => a?.state === "Page: Slash Commands",
    '"Page: Slash Commands", read from the page by PreMiD\'s code',
  );
  assert(first.details === "Viewing Docs", `its own text (${JSON.stringify(first)})`);
  assert(
    discord.handshakes.at(-1) === GUIDE_CLIENT,
    `as its own Application (${discord.handshakes})`,
  );
  log(
    "a real, unmodified PreMiD Activity reads the page and reaches Discord as its own Application",
  );

  const probe = await firefox.evaluate(
    ext,
    `(async () => {
      const [tab] = await browser.tabs.query({ url: "http://discordjs.guide/*" });
      const [result] = await browser.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          let wrote = "no storage";
          try {
            await browser.storage.local.set({ fromContentScript: true });
            wrote = "wrote";
          } catch (error) {
            wrote = "refused: " + error.message;
          }
          return {
            runtime: typeof globalThis.__pmd,
            browser: typeof browser.storage,
            chrome: typeof chrome.storage,
            wrote,
          };
        },
      });
      return result.result;
    })()`,
  );
  assert(probe?.runtime === "object", `the probe ran in PreMiD's world (${JSON.stringify(probe)})`);
  assert(
    probe.browser === "undefined" && probe.chrome === "undefined" && probe.wrote !== "wrote",
    `where the extension's storage is out of reach (${JSON.stringify(probe)})`,
  );
  const leaked = await firefox.evaluate(
    ext,
    `browser.storage.local.get("fromContentScript").then((r) => r.fromContentScript ?? null)`,
  );
  assert(leaked === null, "and nothing it tried to write arrived");
  log(
    "the world PreMiD's code runs in has no storage API: it can neither read nor change settings",
  );

  // --- On without its site: unavailable, and the popup says why ---
  const jummbox = await firefox.openTab("http://jummb.us/");
  await shown((a) => a === null, "nothing: Jummbox can't run without its site");
  // The popup in a window of its own, in the background, so Jummbox's stays the last focused.
  const { context: popup } = await firefox.send("browsingContext.create", {
    type: "window",
    background: true,
  });
  await firefox.navigate(popup, `${EXTENSION}/popup.html`);
  const card = await waitUntil(
    () =>
      firefox.evaluate(
        popup,
        `(() => {
          const view = document.getElementById("suggestion-view");
          return view.hidden ? null : {
            name: document.getElementById("suggestion-name").textContent,
            note: document.getElementById("suggestion-note").textContent,
            action: document.getElementById("suggestion-action").textContent.trim(),
            current: document.getElementById("activity-view").hidden,
          };
        })()`,
      ),
    "the popup's card for Jummbox",
  );
  assert(
    card.name === "Jummbox" && card.note.includes("jummb.us"),
    `says why (${JSON.stringify(card)})`,
  );
  assert(
    card.action === "Allow access" && card.current,
    "offers to ask again, with no empty Current activity",
  );
  await firefox.closeTab(popup);
  log(
    "on without its site, Jummbox is unavailable; the popup names it, says why, and offers to ask",
  );

  // --- The Default Activity, from the dashboard ---
  await firefox.navigate(ext, `${EXTENSION}/fullscreen.html#default`);
  await waitUntil(
    () => firefox.evaluate(ext, `document.getElementById("default-name") !== null`),
    "the Default Activity form",
  );
  await firefox.evaluate(
    ext,
    `(() => {
      const fill = (id, value) => {
        const input = document.getElementById(id);
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      fill("default-name", "Testing Parousia in Firefox");
      fill("default-details", "Nothing else to share");
      document.querySelector('[data-slot="form"]').requestSubmit();
      return true;
    })()`,
  );
  await waitUntil(
    () =>
      firefox.evaluate(
        ext,
        `browser.storage.local.get("defaultActivity").then((r) => r.defaultActivity?.name ?? null)`,
      ),
    "the Default Activity to be saved",
  );
  await firefox.evaluate(ext, `(document.getElementById("default-on").click(), true)`);
  const nothing = await firefox.openTab("http://nothing.example/");
  const custom = await shown(
    (a) => a?.name === "Testing Parousia in Firefox",
    "the Default Activity where no Activity is",
  );
  assert(
    custom.details === "Nothing else to share",
    `with its details (${JSON.stringify(custom)})`,
  );
  await firefox.activate(guide);
  await shown(
    (a) => a?.state === "Page: Slash Commands",
    "DiscordJS Guide again, its tab in front",
  );
  await firefox.closeTab(nothing);
  await firefox.closeTab(jummbox);
  log(
    "the Default Activity: saved from the dashboard, shown where no Activity is, and a detected one wins",
  );

  log("done");
} catch (error) {
  console.error(`--- Desktop log ---\n${desktop?.lines.slice(-40).join("\n") ?? "(not started)"}`);
  throw error;
} finally {
  await firefox?.close().catch(() => {});
  proxy?.close();
  await desktop?.stop();
  await discord.stop();
  await ws.cleanup();
}
