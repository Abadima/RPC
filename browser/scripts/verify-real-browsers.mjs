// End-to-end check against browsers installed on this machine, not
// automation builds: Firefox (Developer Edition, whose signature check can be
// turned off for Parousia's unsigned build) over WebDriver BiDi, the Flatpak
// Ungoogled Chromium over CDP, and the userscript inside Violentmonkey (the
// AMO-signed release) in that Firefox. Every browser gets a throwaway
// profile, and Desktop a throwaway data directory. Desktop runs with its
// tray on the real session bus, so its icon and notifications appear while
// this runs. Local only: needs those installs, a desktop session, and a free
// port 57179.
//
// Covers: Firefox's per-install moz-extension origin refused until allowed,
// with the popup naming the exact command; the Flatpak sandbox's Chromium
// refused as an unrecognized build and allowed from the tray menu; the
// userscript in Violentmonkey, refused until userscripts are turned on from
// the extension's dashboard; three clients at once and resource use; and the
// tray's userscripts toggle.
//
// Prerequisites: `bun run build` here, `cargo build` in ../desktop.

import { chromium } from "playwright-core";
import { execFile, spawn } from "node:child_process";
import { cp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { FIREFOX_BINARY, firefoxPopup, launchFirefox, prepareProfile } from "./e2e/firefox.mjs";
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
  track,
  waitUntil,
  workspace,
} from "./e2e/lib.mjs";

const log = logger("real-browsers");
const run = promisify(execFile);
const FLATPAK_APP = "io.github.ungoogled_software.ungoogled_chromium";
const PAROUSIA_ID = "parousia@abadima.dev";
const PAROUSIA_UUID = "5c0e1d6a-3f6e-4b8e-9a51-1c2d3e4f5a6b";
const VM_ID = "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}";
const VM_UUID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const VM_XPI = join(browserDir, ".cache", "e2e", "violentmonkey.xpi");
const CDP_PORT = 9333;

// --- Flatpak Ungoogled Chromium over CDP ---

async function launchFlatpak(profileDir, extensionDir) {
  const child = track(
    spawn(
      "flatpak",
      [
        "run",
        FLATPAK_APP,
        "--headless=new",
        `--user-data-dir=${profileDir}`,
        `--load-extension=${extensionDir}`,
        `--remote-debugging-port=${CDP_PORT}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: "ignore" },
    ),
  );
  const browser = await waitUntil(
    () => chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`).catch(() => false),
    "the Flatpak browser's CDP endpoint",
  );
  const context = browser.contexts()[0];
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: STEP_TIMEOUT_MS }));
  const id = new URL(worker.url()).host;
  await worker.evaluate(QUIET_DISCORD);
  return {
    browser,
    context,
    id,
    origin: `chrome-extension://${id}`,
    async close() {
      // `browser.close()` only disconnects from a CDP-attached browser.
      const session = await browser.newBrowserCDPSession();
      await session.send("Browser.close").catch(() => {});
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(10_000)]);
      child.kill();
    },
  };
}

async function flatpakPopup(flatpak) {
  const page = await flatpak.context.newPage();
  await page.goto(`chrome-extension://${flatpak.id}/popup.html`);
  return page;
}

// --- Firefox with Parousia and Violentmonkey ---

async function startFirefox(ws, profileDir, homeDir) {
  const firefox = await launchFirefox({ profileDir, env: { ...ws.env, HOME: homeDir } });
  const context = await firefox.openTab(`moz-extension://${PAROUSIA_UUID}/popup.html`);
  // Firefox gives no earlier hook: at worst the popup's first moment connects to a
  // real app on 6969 and sends nothing (no Activity, no Discord client id).
  await firefox.evaluate(context, QUIET_DISCORD);
  return { firefox, context };
}

function serveUserscript(userscript) {
  const server = createServer((request, response) => {
    if (request.url === "/parousia.user.js") {
      response.writeHead(200, { "content-type": "text/javascript" });
      response.end(userscript);
    } else if (request.url === "/page.html") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Parousia userscript test</title><p>test page</p>");
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }),
    ),
  );
}

/**
 * Clicks one of the userscript's menu commands in Violentmonkey's popup. The
 * popup lists the commands of its window's active tab, so `pageContext` is
 * activated and the popup opened behind it, the same state as a person
 * clicking the toolbar button on that page.
 */
async function runMenuCommand(firefox, pageContext, label) {
  await firefox.activate(pageContext);
  const popupContext = await firefox.openTab(`moz-extension://${VM_UUID}/popup/index.html`, {
    background: true,
  });
  try {
    await waitUntil(
      () =>
        firefox.evaluate(
          popupContext,
          `(() => {
            const label = [...document.querySelectorAll(".menu-item span")].find(
              (el) => el.textContent.trim() === ${JSON.stringify(label)},
            );
            const item = label?.closest(".menu-item");
            if (!item) return false;
            // Violentmonkey runs a command on a press (mousedown then mouseup
            // on the same item), like a real mouse click, not on "click".
            for (const type of ["mousedown", "mouseup"]) {
              item.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0 }));
            }
            return true;
          })()`,
        ),
      `Violentmonkey's "${label}" command`,
    );
  } finally {
    await firefox.closeTab(popupContext).catch(() => {});
  }
}

// --- The tray menu over D-Bus ---

/** The tray menu's items, flattened: [{ id, label, toggleState }]. */
async function trayItems(trayName) {
  const { stdout } = await run("busctl", [
    "--user",
    "--json=short",
    "call",
    trayName,
    "/MenuBar",
    "com.canonical.dbusmenu",
    "GetLayout",
    "--",
    "iias",
    "0",
    "-1",
    "0",
  ]);
  const items = [];
  const walk = ([id, props, children]) => {
    items.push({ id, label: props.label?.data ?? "", toggleState: props["toggle-state"]?.data });
    for (const child of children) walk(child.data);
  };
  walk(JSON.parse(stdout).data[1]);
  return items;
}

async function clickTrayItem(trayName, find, description) {
  const item = await waitUntil(
    async () => (await trayItems(trayName)).find(find),
    `the tray item ${description}`,
  );
  await run("busctl", [
    "--user",
    "call",
    trayName,
    "/MenuBar",
    "com.canonical.dbusmenu",
    "Event",
    "--",
    "isvu",
    String(item.id),
    "clicked",
    "s",
    "",
    "0",
  ]);
  return item;
}

// --- Resource use ---

async function processStats(pid) {
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const field = (name) => new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(status)?.[1];
  return { rssKb: Number(field("VmRSS")), threads: Number(field("Threads")) };
}

// --- The run ---

const ws = await workspace("prb");
const firefoxProfile = join(ws.dir, "firefox-profile");
const firefoxHome = join(ws.dir, "firefox-home");
const flatpakProfile = join(ws.dir, "flatpak-profile");
const flatpakExtension = join(ws.dir, "ext-chromium");
let desktop;
let ff;
let flatpak;
let page;

try {
  desktop = startDesktop(ws, { tray: true });
  await desktop.waitFor(/listening on 127\.0\.0\.1:57179/);
  await waitUntil(
    async () =>
      (
        await run("busctl", [
          "--user",
          "get-property",
          "org.kde.StatusNotifierWatcher",
          "/StatusNotifierWatcher",
          "org.kde.StatusNotifierWatcher",
          "RegisteredStatusNotifierItems",
        ])
      ).stdout.includes(desktop.trayName),
    "the tray to register with the panel",
  );
  log(`Desktop running with its tray registered in the panel (${desktop.trayName})`);

  // --- Firefox: its per-install origin must be allowed ---
  await prepareProfile(firefoxProfile, [
    { id: PAROUSIA_ID, xpi: join(browserDir, "dist", "firefox.zip"), uuid: PAROUSIA_UUID },
    { id: VM_ID, xpi: VM_XPI, uuid: VM_UUID },
  ]);
  let since = desktop.mark();
  ff = await startFirefox(ws, firefoxProfile, firefoxHome);
  const firefoxVersion = (await run(FIREFOX_BINARY, ["--version"])).stdout.trim();
  const firefoxOrigin = `moz-extension://${PAROUSIA_UUID}`;
  await firefoxPopup.waitForStatus(ff.firefox, ff.context, /^Not allowed by Parousia Desktop$/);
  const firefoxHelp = await firefoxPopup.help(ff.firefox, ff.context);
  assert(
    firefoxHelp?.includes(`Parousia-Desktop allow ${firefoxOrigin}`),
    `Firefox names its own origin: ${firefoxHelp}`,
  );
  await control(ws, "allow", firefoxOrigin);
  await firefoxPopup.reopen(ff.firefox, ff.context);
  await firefoxPopup.waitForStatus(ff.firefox, ff.context, /^Connected to Parousia Desktop$/);
  await desktop.waitFor(new RegExp(`Firefox on Linux connected from ${firefoxOrigin}`), since);
  await desktop.waitFor(/presence from Firefox on Linux: none/, since);
  log(
    `${firefoxVersion}: refused until its per-install origin was allowed, then connected, Presence arrived`,
  );

  // --- Flatpak Ungoogled Chromium: refused, allowed from the tray ---
  await cp(join(browserDir, "dist", "chromium"), flatpakExtension, { recursive: true });
  flatpak = await launchFlatpak(flatpakProfile, flatpakExtension);
  const flatpakVersion = flatpak.browser.version();
  page = await flatpakPopup(flatpak);
  await popup.waitForStatus(page, /^Not allowed by Parousia Desktop$/);
  await desktop.waitFor(new RegExp(`refused ${flatpak.origin}: not an allowed Parousia build`));
  since = desktop.mark();
  const allowItem = await clickTrayItem(
    desktop.trayName,
    (item) => item.label.startsWith(`Allow ${flatpak.origin} `),
    `"Allow ${flatpak.origin}"`,
  );
  await desktop.waitFor(new RegExp(`Allowed ${flatpak.origin}`), since);
  await page.close();
  page = await flatpakPopup(flatpak);
  await popup.waitForStatus(page, /^Connected to Parousia Desktop$/);
  log(
    `Flatpak Ungoogled Chromium ${flatpakVersion}: unrecognized build refused, then allowed from the tray ("${allowItem.label}")`,
  );

  // --- The userscript in Violentmonkey ---
  const userscript = await readFile(
    join(browserDir, "dist", "userscript", "parousia.user.js"),
    "utf8",
  );
  const site = await serveUserscript(userscript);
  const pageContext = await ff.firefox.openTab("about:blank");
  await ff.firefox.navigate(pageContext, `${site.origin}/parousia.user.js`).catch(() => {});
  const confirm = await waitUntil(
    async () =>
      (await ff.firefox.contexts()).find((c) =>
        c.url.startsWith(`moz-extension://${VM_UUID}/confirm/`),
      ),
    "Violentmonkey's install page",
  );
  await waitUntil(
    () =>
      ff.firefox.evaluate(
        confirm.context,
        `(() => { const b = document.getElementById("confirm"); if (!b || b.disabled) return false; b.click(); return true; })()`,
      ),
    "Violentmonkey's Install button",
  );
  // Violentmonkey saves the script right after the click; give it a moment.
  await sleep(1500);
  await ff.firefox.closeTab(confirm.context).catch(() => {});
  await ff.firefox.navigate(pageContext, `${site.origin}/page.html`);
  let statusAlert = ff.firefox.nextPrompt();
  await runMenuCommand(ff.firefox, pageContext, "Parousia Desktop status");
  let reported = (await statusAlert).message;
  assert(
    reported.startsWith("Parousia: Not connected to Parousia Desktop.") &&
      reported.includes("Allow userscripts"),
    `status alert while userscripts are off: ${reported}`,
  );
  const vmVersion = JSON.parse(
    (await run("unzip", ["-p", VM_XPI, "manifest.json"])).stdout,
  ).version;
  log(
    `userscript installed through Violentmonkey ${vmVersion}: refused by default (a bare 403), and its status command says how to allow it`,
  );

  // Turned on from the extension's Settings.
  const dashboard = await ff.firefox.openTab(
    `moz-extension://${PAROUSIA_UUID}/fullscreen.html#settings/general`,
  );
  await waitUntil(
    () => ff.firefox.evaluate(dashboard, `!document.getElementById("desktop-report").hidden`),
    "the dashboard's Desktop settings",
  );
  since = desktop.mark();
  await ff.firefox.evaluate(
    dashboard,
    `document.getElementById("setting-allowUserscripts").click()`,
  );
  await desktop.waitFor(/Userscripts turned on/, since);
  await waitUntil(
    () =>
      ff.firefox.evaluate(dashboard, `document.getElementById("setting-allowUserscripts").checked`),
    "the dashboard to show the new setting",
  );
  await ff.firefox.navigate(pageContext, `${site.origin}/page.html?allowed`);
  statusAlert = ff.firefox.nextPrompt();
  await runMenuCommand(ff.firefox, pageContext, "Parousia Desktop status");
  reported = (await statusAlert).message;
  assert(reported === "Parousia: Connected to Parousia Desktop.", `status alert: ${reported}`);
  // Firefox sends `Origin: null` for a content script's WebSocket.
  await desktop.waitFor(/Userscript in Firefox on Linux connected from null/, since);
  await waitUntil(async () => (await status(ws)).clients.length === 3, "three clients connected");
  log(
    `"Allow userscripts" turned on from the extension's Settings; the userscript then connects (Origin null)`,
  );

  // --- Three clients at once ---
  let report = await status(ws);
  const summary = report.clients.map((c) => c.name).join(", ");
  assert(report.clients.length === 3, `three clients connected at once: ${summary}`);
  const desktopStats = await processStats(desktop.pid);
  log(`three clients connected at once: ${summary}`);
  log(
    `resources with 3 clients up: Desktop ${desktopStats.rssKb} kB RSS, ${desktopStats.threads} threads`,
  );

  // --- The tray's userscripts toggle ---
  const userscriptToggle = (await trayItems(desktop.trayName)).find((item) =>
    item.label.startsWith("Allow userscripts"),
  );
  assert(userscriptToggle?.toggleState === 1, "the tray shows userscripts as on");
  await clickTrayItem(
    desktop.trayName,
    (item) => item.id === userscriptToggle.id,
    "Allow userscripts",
  );
  await waitUntil(async () => {
    const current = await status(ws);
    return !current.settings.allowUserscripts && current.clients.length === 2;
  }, "userscripts off and the userscript dropped");
  log("tray toggle: userscripts off drops the userscript, the other two browsers stay connected");

  site.server.close();
  log("done");
} catch (error) {
  console.error(`--- Desktop log ---\n${desktop?.lines.slice(-40).join("\n") ?? "(not started)"}`);
  throw error;
} finally {
  await page?.close().catch(() => {});
  await flatpak?.close().catch(() => {});
  await ff?.firefox.close().catch(() => {});
  await desktop?.stop();
  await ws.cleanup();
}
