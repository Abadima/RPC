// End-to-end check of Activities, with real processes: an extension build in
// playwright-core's isolated Chromium, the Parousia Desktop debug build, and
// a stand-in Discord (e2e/fake-discord.mjs). Pages are served by the test;
// no network is needed.
//
// The build is its own: real PreMiD Activities from the fetched checkout, the
// native test Activities in scripts/activities/fixtures/parousia, and one
// more native Activity written here for DiscordJS Guide, a website PreMiD
// has too, so the build has a website in both sources.
//
// Covers:
// - A website in both sources: listed once, the native one running until
//   PreMiD's is chosen in the dashboard, then only PreMiD's, as its own
//   Discord Application.
// - PreMiD: a real, unmodified Activity reading the page, following a
//   change, and what its code can't reach; an Activity that's on without its
//   site granted is unavailable (nothing injected, nothing shown), and the
//   popup and dashboard say so and offer to ask again.
// - Native: an Activity that reads pages is off until turned on, which the
//   popup does in one click; the collector reads the page's Media Session.
// - Settings > Privacy: what Activities may read, for all of them at once.
// - The popup: "Current activity" only while something's shared, "Configure
//   activity" for an Activity with settings, and a quiet line otherwise.
// - The Default Activity: written in the dashboard, shared where no Activity
//   is, and gone once it's off.
// - The dashboard: switches, icons and their fallback, site access in
//   Settings only ("all websites" off), and the layout from phone to
//   ultrawide.
//
// A browser grants a site only through a prompt automation can't answer, so
// this build's manifest already holds the sites it tests as if granted
// (Jummbox's deliberately not). Everything after that is the real path.
//
// `ACTIVITIES_BROWSER=flatpak` runs the same checks in the Flatpak Ungoogled
// Chromium installed on this machine (over CDP) instead of playwright-core's.
//
// Prerequisites: `bun run activities:fetch`, and `cargo build` in ../desktop.
// Linux only; port 57179 must be free.

import { chromium } from "playwright-core";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { startFakeDiscord } from "./e2e/fake-discord.mjs";
import {
  PAROUSIA_CLIENT_ID,
  QUIET_DISCORD,
  STEP_TIMEOUT_MS,
  assert,
  browserDir,
  control,
  logger,
  sleep,
  startDesktop,
  track,
  waitUntil,
  workspace,
  readManifest,
} from "./e2e/lib.mjs";

const log = logger("activities");
const run = promisify(execFile);

const GUIDE = "premid:DiscordJS Guide";
const GUIDE_NATIVE = "discordjs-guide";
const GUIDE_CLIENT = "819865300173324288";
const GUIDE_PAGE = "https://discordjs.guide/creating-your-bot/slash-commands";
const JUMMBOX = "premid:Jummbox";
const ARCH = "premid:ArchLinux";
const ARCH_CLIENT = "929881116679237653";
const TUNES_PAGE = "https://tunes.example/listen/1";
const EXAMPLE_PAGE = "https://example.site/docs";
const NOTHING_PAGE = "https://nothing.example/";
const COVER = "https://img.example/cover.png";
/** A 1×1 PNG, served as any icon the dashboard asks for. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const FLATPAK_APP = "io.github.ungoogled_software.ungoogled_chromium";
const CDP_PORT = 9334;
const flatpak = process.env.ACTIVITIES_BROWSER === "flatpak";

/**
 * The browser: playwright-core's Chromium, or the installed Flatpak one
 * attached over CDP. Either way, a context whose pages and routes work the
 * same, and a way to close it.
 */
async function launchBrowser(profileDir, extensionDir) {
  const args = [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`];
  if (!flatpak) {
    const context = await chromium.launchPersistentContext(profileDir, {
      channel: "chromium",
      headless: true,
      args,
    });
    return { context, name: "playwright-core's Chromium", close: () => context.close() };
  }
  const child = track(
    spawn(
      "flatpak",
      [
        "run",
        FLATPAK_APP,
        "--headless=new",
        "--window-size=1280,900",
        `--user-data-dir=${profileDir}`,
        ...args,
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
  return {
    context: browser.contexts()[0],
    name: `Flatpak Ungoogled Chromium ${browser.version()}`,
    async close() {
      // `browser.close()` only disconnects from a CDP-attached browser.
      const session = await browser.newBrowserCDPSession();
      await session.send("Browser.close").catch(() => {});
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(10_000)]);
      child.kill();
    },
  };
}

const ws = await workspace("pav");
const discord = await startFakeDiscord(ws.discordDir);
const extensionDir = join(ws.dir, "extension");
let desktop;
let context;
let launched;

/** Waits for Discord to show something passing `check`, and returns it. */
const shown = (check, description) => discord.waitFor(check, description);

/** Serves `body` as HTML for every page under `origin`. */
async function serve(page, origin, body) {
  await page.route(`${origin}/**`, (route) => route.fulfill({ contentType: "text/html", body }));
}

try {
  // --- A build of its own ---
  const natives = join(ws.dir, "natives");
  await cp(join(browserDir, "scripts", "activities", "fixtures", "parousia"), natives, {
    recursive: true,
  });
  const guideFolder = join(natives, "websites", "D", "DiscordJS Guide");
  await mkdir(guideFolder, { recursive: true });
  await writeFile(
    join(guideFolder, "metadata.json"),
    JSON.stringify({
      apiVersion: 1,
      id: GUIDE_NATIVE,
      name: "DiscordJS Guide",
      description: "The native side of a website PreMiD has too, for tests.",
      version: "1.0.0",
      authors: [{ name: "Test" }],
      matches: ["https://discordjs.guide/*"],
    }),
  );
  await writeFile(
    join(guideFolder, "activity.ts"),
    `export default {
  detect: (page: { title: string }) => ({
    id: "${GUIDE_NATIVE}",
    name: "DiscordJS Guide",
    details: "Reading the guide",
    state: page.title,
  }),
};
`,
  );
  await run("bun", ["run", "build.ts"], {
    cwd: browserDir,
    env: {
      ...process.env,
      PAROUSIA_ACTIVITIES_DIR: natives,
      PAROUSIA_BUILD_DIR: join(ws.dir, "dist"),
    },
  });
  await cp(join(ws.dir, "dist", "chromium"), extensionDir, { recursive: true });
  const guide = await readManifest(extensionDir, GUIDE);
  assert(
    guide && (await readManifest(extensionDir, JUMMBOX)),
    "both PreMiD Activities are packaged (run `bun run activities:fetch`)",
  );
  assert(
    guide.script.clientIds[0] === GUIDE_CLIENT,
    `DiscordJS Guide has its own client id (${guide.script.clientIds})`,
  );
  const variants = [GUIDE_NATIVE, GUIDE];
  assert(
    JSON.stringify(guide.info.variants) === JSON.stringify(variants),
    `PreMiD's DiscordJS Guide knows the native one (${guide.info.variants})`,
  );
  const manifestPath = join(extensionDir, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.permissions = [...manifest.permissions, "scripting"];
  // Arch Linux's regExp takes every subdomain of archlinux.org, so what it asks for does too.
  const arch = await readManifest(extensionDir, ARCH);
  assert(
    JSON.stringify(arch?.info.origins) === JSON.stringify(["*://*.archlinux.org/*"]),
    `Arch Linux asks for its subdomains (${arch?.info.origins})`,
  );
  manifest.host_permissions = [
    ...guide.info.origins,
    ...arch.info.origins,
    "https://tunes.example/*",
  ];
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  log(
    "built with PreMiD's Activities, the native test ones, and a native DiscordJS Guide; DiscordJS Guide's and Tunes' sites held as granted, Jummbox's not",
  );

  // --- Desktop, and a browser it allows ---
  desktop = startDesktop(ws);
  await desktop.waitFor(/listening on 127\.0\.0\.1:57179/);
  launched = await launchBrowser(join(ws.dir, "profile"), extensionDir);
  context = launched.context;
  log(`in ${launched.name}`);
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker", { timeout: STEP_TIMEOUT_MS }));
  const id = new URL(worker.url()).host;
  const extension = `chrome-extension://${id}`;
  await worker.evaluate(QUIET_DISCORD);
  await control(ws, "allow", extension);
  const setStates = (states) =>
    worker.evaluate((activities) => chrome.storage.local.set({ activities }), states);
  const states = () =>
    worker.evaluate(async () => (await chrome.storage.local.get("activities")).activities ?? {});
  const preferences = () =>
    worker.evaluate(async () => (await chrome.storage.local.get("preferences")).preferences ?? {});

  /**
   * The popup for `page`'s tab: a window of its own that isn't focused, so
   * the browser window `page` is in stays the last focused one, as behind a
   * real popup. `close` closes it and focuses `page`'s window again, as
   * closing a real popup leaves it.
   */
  async function popupFor(page) {
    await page.bringToFront();
    const opened = context.waitForEvent("page", (p) => p.url().endsWith("/popup.html"));
    await worker.evaluate(() =>
      chrome.windows.create({ url: chrome.runtime.getURL("popup.html"), focused: false }),
    );
    const popup = await opened;
    await popup.waitForLoadState();
    popup.done = async () => {
      await popup.close();
      await page.bringToFront();
      await worker.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        if (tab) await chrome.windows.update(tab.windowId, { focused: true });
      }, page.url());
    };
    return popup;
  }

  const dashboard = await context.newPage();
  await dashboard.route("https://cdn.rcd.gg/**", (route) =>
    route.request().url().includes("DiscordJS")
      ? route.fulfill({ contentType: "image/png", body: PNG })
      : route.abort(),
  );
  /** The dashboard, in front: a background tab isn't laid out in a real browser. */
  const openDashboard = async (hash) => {
    await dashboard.bringToFront();
    await dashboard.goto(`${extension}/fullscreen.html${hash}`);
  };

  // --- One website, two implementations: the native one runs until PreMiD's is chosen ---
  const guidePage = await context.newPage();
  await serve(
    guidePage,
    "https://discordjs.guide",
    `<!doctype html><title>Slash commands | discord.js Guide</title>
     <link rel="icon" type="image/png" href="https://discordjs.guide/static/guide.png?v=7">
     <h1>Slash Commands</h1>`,
  );
  // The test Activity has no icon of its own and sends no image, so what shows
  // is the tab's favicon (without its query string), never Parousia's logo.
  await guidePage.route("https://discordjs.guide/static/guide.png*", (route) =>
    route.fulfill({ contentType: "image/png", body: PNG }),
  );
  await guidePage.goto(GUIDE_PAGE);
  const native = await shown(
    (a) =>
      a?.details === "Reading the guide" &&
      a.assets?.large_image === "https://discordjs.guide/static/guide.png",
    "the native DiscordJS Guide, on until turned off, with the page's favicon as its image",
  );
  assert(native.state === "Slash commands | discord.js Guide", `from the title (${native.state})`);
  assert(discord.handshakes.at(-1) === PAROUSIA_CLIENT_ID, "as Parousia's own Application");

  await openDashboard("#activities?q=discordjs");
  await dashboard.locator(".activity-card").first().waitFor();
  const guideCards = await dashboard
    .locator(".activity-card")
    .evaluateAll((cards) => cards.map((card) => card.dataset.activity));
  assert(
    JSON.stringify(guideCards) === JSON.stringify([GUIDE_NATIVE]),
    `listed once, as the native one (${guideCards})`,
  );
  assert(
    (await dashboard.textContent(`[data-activity="${GUIDE_NATIVE}"]`))?.includes("multi"),
    "and marked as in both sources",
  );
  await openDashboard(`#activities/${GUIDE_NATIVE}`);
  const choices = dashboard.locator("[data-variant]");
  await choices.first().waitFor();
  assert((await choices.count()) === 2, "its page offers both implementations");
  assert(
    (await dashboard.getAttribute(`[data-variant="${GUIDE_NATIVE}"]`, "aria-checked")) === "true",
    "the native one chosen",
  );
  await dashboard.click(`[data-variant="${GUIDE}"]`);
  await waitUntil(
    async () => (await states())[GUIDE_NATIVE]?.use === GUIDE,
    "PreMiD's to be chosen",
  );
  assert((await states())[GUIDE]?.on === true, "and on, since the website was");
  await dashboard.waitForURL(/#activities\/premid%3ADiscordJS%20Guide$/);

  await guidePage.bringToFront();
  const first = await shown(
    (a) => a?.state === "Page: Slash Commands",
    '"Page: Slash Commands", read from the page by PreMiD\'s code',
  );
  assert(first.details === "Viewing Docs", `its own text (${JSON.stringify(first)})`);
  assert(
    discord.handshakes.at(-1) === GUIDE_CLIENT,
    `as its own Discord Application (${discord.handshakes})`,
  );
  await openDashboard("#activities?q=discordjs");
  await dashboard.locator(`.activity-card[data-activity="${GUIDE}"]`).waitFor();
  assert((await dashboard.locator(".activity-card").count()) === 1, "still one card, now PreMiD's");
  log(
    "a website in both sources is listed once; the native one runs until PreMiD's is chosen, then only PreMiD's, as its own Application",
  );

  // --- What PreMiD's code can't reach ---
  const reach = await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        // Withheld from this world by PreMiD's runtime, and restricted by the background too.
        let storage = "readable";
        try {
          await chrome.storage.local.get("preferences");
        } catch (error) {
          storage = `refused: ${error.message}`;
        }
        const answer = await new Promise((resolve) => {
          const port = chrome.runtime.connect({ name: "parousia-ui" });
          const timer = setTimeout(() => resolve("no answer"), 1500);
          port.onMessage.addListener(() => {
            clearTimeout(timer);
            resolve("answered");
          });
        });
        return { storage, answer };
      },
    });
    return result.result;
  }, `${GUIDE_PAGE}*`);
  assert(
    reach?.storage.startsWith("refused"),
    `content scripts can't read storage (${reach?.storage})`,
  );
  assert(reach?.answer === "no answer", `nor use the dashboard's port (${reach?.answer})`);
  log(
    "a content script (where PreMiD code runs) can't read the extension's storage or use its UI port",
  );

  await guidePage.bringToFront();
  await shown((a) => a?.state === "Page: Slash Commands", "DiscordJS Guide, its tab in front");
  await guidePage.evaluate(() => {
    const heading = document.querySelector("h1");
    if (heading) heading.textContent = "Event Handling";
  });
  await shown((a) => a?.state === "Page: Event Handling", "the new heading");
  log("a change on the page reaches Discord on the Activity's next tick");

  // --- Settings > Privacy: what Activities may read, for every one at once ---
  await openDashboard("#settings/privacy");
  const media = dashboard.locator('[data-kind="media"] .switch');
  await media.waitFor();
  assert(
    (await dashboard.locator("[data-kind]").count()) === 3,
    "one switch per kind of page data",
  );
  assert(await media.isChecked(), "each on by default");
  await media.click();
  await waitUntil(async () => (await preferences()).pageData?.media === false, "media to be off");
  await guidePage.bringToFront();
  const plain = await shown(
    (a) => a?.name === "DiscordJS Guide" && !a.details && !a.state,
    "only its name, with what's playing off",
  );
  assert(
    plain.assets?.large_image?.startsWith("https://cdn.rcd.gg/"),
    `its own image stays (${JSON.stringify(plain.assets)})`,
  );
  await openDashboard("#settings/privacy");
  await media.click();
  await waitUntil(async () => (await preferences()).pageData?.media === true, "media to be on");
  await guidePage.bringToFront();
  await shown(
    (a) => a?.state === "Page: Event Handling",
    "the page's text again, switched back on",
  );
  log(
    "Settings > Privacy switches what's playing off for every Activity: Discord shows only the name and icon; back on, the page's text",
  );

  // --- On, without its site: unavailable, and the popup says so ---
  await setStates({ ...(await states()), [JUMMBOX]: { on: true } });
  const jummbox = await context.newPage();
  await serve(jummbox, "https://jummb.us", "<!doctype html><title>JummBox</title><p>Beep</p>");
  await jummbox.goto("https://jummb.us/");
  await shown((a) => a === null, "nothing: Jummbox can't run without its site");
  const injected = await jummbox.evaluate(() =>
    document.documentElement.outerHTML.includes("Making a Beep"),
  );
  assert(!injected, "its script never ran there");
  let popup = await popupFor(jummbox);
  await popup.locator("#suggestion-view:not([hidden])").waitFor();
  assert(await popup.isHidden("#activity-view"), "the popup hides Current activity");
  assert((await popup.textContent("#suggestion-name")) === "Jummbox", "and names the Activity");
  assert(
    (await popup.textContent("#suggestion-note"))?.includes("access to jummb.us"),
    `and why it isn't running (${await popup.textContent("#suggestion-note")})`,
  );
  assert(
    (await popup.textContent("#suggestion-action"))?.trim() === "Allow access",
    "offering to ask again",
  );
  await popup.done();

  await openDashboard(`#activities?q=jummbox`);
  const jummboxCard = dashboard.locator(`.activity-card[data-activity="${JUMMBOX}"]`);
  await jummboxCard.waitFor();
  assert(
    (await jummboxCard.textContent())?.includes("Needs access"),
    "its card says it needs access",
  );
  await waitUntil(
    async () => (await jummboxCard.locator(".activity-image").count()) === 0,
    "Jummbox's icon to fail",
  );
  assert(
    (await jummboxCard.locator(".activity-icon").getAttribute("data-icon")) === "letter",
    "and keeps its letter where its icon doesn't load",
  );
  await openDashboard(`#activities/${encodeURIComponent(JUMMBOX)}`);
  await dashboard.locator('[data-slot="notice"]:not([hidden])').waitFor();
  assert(
    (await dashboard.textContent('[data-slot="notice"]'))?.includes("jummb.us"),
    "its page says which site it can't read",
  );
  assert(await dashboard.isVisible('[data-slot="allow"]'), "with a button to ask again");
  assert(
    (await dashboard.locator("[data-site], [data-kind]").count()) === 0,
    "and no per-site or per-kind switches of its own",
  );
  log(
    "on without its site, a PreMiD Activity is unavailable: nothing injected or shown; the popup, its card, and its page say why and offer to ask",
  );
  await jummbox.close();

  // --- A native Activity that reads pages: off until turned on, from the popup ---
  const tunes = await context.newPage();
  await serve(
    tunes,
    "https://tunes.example",
    `<!doctype html><title>Tunes</title><audio></audio><script>
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "Never Gonna Give You Up", artist: "Rick Astley",
        artwork: [{ src: "${COVER}", sizes: "512x512" }],
      });
    </script>`,
  );
  await tunes.goto(TUNES_PAGE);
  await shown((a) => a === null, "nothing: Tunes reads pages, so it's off until turned on");
  popup = await popupFor(tunes);
  await popup.locator("#suggestion-view:not([hidden])").waitFor();
  assert(
    (await popup.textContent("#suggestion-action"))?.trim() === "Turn on",
    "the popup offers to turn it on",
  );
  await popup.click("#suggestion-action");
  await waitUntil(async () => (await states()).tunes?.on === true, "Tunes to be on");
  await popup.done();
  await tunes.bringToFront();
  const song = await shown(
    (a) => a?.details === "Never Gonna Give You Up",
    "the song, from the page's Media Session",
  );
  assert(song.assets?.large_image === COVER, `and its artwork (${JSON.stringify(song.assets)})`);
  assert(discord.handshakes.at(-1) === PAROUSIA_CLIENT_ID, "as Parousia's own Application");
  await openDashboard("#settings/privacy");
  await dashboard.locator('[data-kind="thumbnails"] .switch').click();
  await tunes.bringToFront();
  await shown(
    (a) =>
      a?.details === "Never Gonna Give You Up" &&
      a.assets?.large_image === "https://tunes.example/icon.png",
    "the site's own logo, not the song's artwork (and not Parousia's logo), once thumbnails are off",
  );
  log(
    "native: Tunes is off until the popup turns it on in one click; then the collector reads the page's Media Session, and the site's logo instead of the artwork once thumbnails are off",
  );

  // --- The popup while sharing: Configure activity ---
  const example = await context.newPage();
  await serve(example, "https://example.site", "<!doctype html><title>Docs</title>");
  await example.goto(EXAMPLE_PAGE);
  await shown((a) => a?.details === "Reading Docs", "Example Site, with its default prefix");
  popup = await popupFor(example);
  await popup.locator("#activity-view:not([hidden])").waitFor();
  assert(await popup.isHidden("#suggestion-view"), "the popup shows Current activity alone");
  await popup.click("#configure-button");
  const prefix = popup.locator("#configure-view input.text-field");
  await prefix.waitFor();
  await prefix.fill("Browsing");
  await prefix.press("Enter");
  await popup.done();
  await example.bringToFront();
  await shown((a) => a?.details === "Browsing Docs", "the new prefix, set from the popup");
  log(
    "the popup shows Current activity only while sharing, and changes the Activity's settings in place",
  );

  // --- The Default Activity ---
  const nothing = await context.newPage();
  await serve(nothing, "https://nothing.example", "<!doctype html><title>Nothing</title>");
  await nothing.goto(NOTHING_PAGE);
  await shown((a) => a === null, "nothing on a site no Activity covers");
  popup = await popupFor(nothing);
  await popup.locator("#idle-view:not([hidden])").waitFor();
  assert(
    (await popup.textContent("#idle-view")) === "Nothing to share on this page.",
    "the popup says so in one line",
  );
  assert(
    (await popup.isHidden("#activity-view")) && (await popup.isHidden("#suggestion-view")),
    "without an empty Current activity",
  );
  await popup.done();

  await openDashboard("#default");
  await dashboard.locator("#default-name").waitFor();
  const nav = await dashboard
    .locator(".nav-link")
    .evaluateAll((links) => links.map((link) => link.dataset.route));
  assert(
    JSON.stringify(nav) === JSON.stringify(["overview", "activities", "default", "settings"]),
    `its tab sits between Activities and Settings (${nav})`,
  );
  await dashboard.click("#default-on");
  assert(!(await dashboard.isChecked("#default-on")), "it won't turn on without a name");
  assert(await dashboard.isVisible("#default-name-error"), "and says what's missing");
  await dashboard.fill("#default-name", "Testing Parousia");
  await dashboard.fill("#default-details", "Nothing else to share");
  await dashboard.fill("#default-button-0-label", "Parousia");
  await dashboard.fill("#default-button-0-url", "javascript:alert(1)");
  await dashboard.click('[data-slot="form"] button[type="submit"]');
  assert(
    await dashboard.isVisible('[data-slot="form"] .field-error:not([hidden])'),
    "a button link that isn't a web address isn't saved",
  );
  await dashboard.fill("#default-button-0-url", "https://github.com/Abadima/RPC");
  await dashboard.click('[data-slot="form"] button[type="submit"]');
  await dashboard.click("#default-on");
  await nothing.bringToFront();
  const custom = await shown(
    (a) => a?.name === "Testing Parousia",
    "the Default Activity, where no Activity is",
  );
  assert(
    custom.details === "Nothing else to share",
    `with its details (${JSON.stringify(custom)})`,
  );
  assert(custom.buttons?.[0]?.url === "https://github.com/Abadima/RPC", "and its button");
  assert(typeof custom.timestamps?.start === "number", "and elapsed time");
  await example.bringToFront();
  await shown((a) => a?.name === "Example Site", "a detected Activity instead, where there is one");
  await openDashboard("#default");
  await dashboard.locator("#default-on").waitFor();
  await dashboard.click("#default-on");
  await nothing.bringToFront();
  await shown((a) => a === null, "nothing, once the Default Activity is off");
  log(
    "the Default Activity: its own tab, a name required and links checked, shared where no Activity is, and gone once off",
  );

  // --- Site access lives in Settings: only "all websites", off by default ---
  await openDashboard("#settings/access");
  await dashboard.waitForSelector("#setting-allSites");
  assert(
    !(await dashboard.isChecked("#setting-allSites")),
    '"Access your data for all websites" is off by default',
  );
  assert(
    (await dashboard.locator("#granted-sites, [data-site]").count()) === 0,
    "individual sites aren't listed or revocable here, the browser owns those",
  );
  log('site access: only "all websites" is managed here, and it is off');

  // --- The Activities page: enabled first, filters, enable or disable all ---
  const beforeList = await states();
  await setStates({ ...beforeList, [JUMMBOX]: { on: true } });
  const cardsShown = () =>
    dashboard.locator(".activity-card").evaluateAll((cards) =>
      cards.map((card) => ({
        id: card.dataset.activity,
        name: card.querySelector(".row-title")?.textContent ?? "",
        on: card.querySelector(".switch")?.checked ?? false,
      })),
    );
  const byName = new Intl.Collator("en", { numeric: true });
  await openDashboard("#activities");
  await dashboard.locator(".activity-card").first().waitFor();
  const firstPage = await cardsShown();
  const firstOff = firstPage.findIndex((card) => !card.on);
  assert(
    firstOff > 0 && firstPage.slice(firstOff).every((card) => !card.on),
    `enabled Activities come first, then disabled ones (${firstPage.map((c) => `${c.name}:${c.on}`)})`,
  );
  const enabledNames = firstPage.slice(0, firstOff).map((card) => card.name);
  assert(
    enabledNames.every((name, i) => i === 0 || byName.compare(enabledNames[i - 1], name) <= 0) &&
      firstPage.slice(0, firstOff).some((card) => card.id === JUMMBOX),
    `each group by name, an Activity that needs access counting once it is on (${enabledNames})`,
  );

  // Filters: Enabled, then narrowed to PreMiD's, kept in the address, cleared.
  assert(
    (await dashboard.getAttribute('[data-slot="filter-toggle"]', "aria-expanded")) === "false",
    "the Filter menu starts closed",
  );
  await dashboard.click('[data-slot="filter-toggle"]');
  await dashboard.check('[data-filter="status"][value="enabled"]');
  const enabledOnly = await cardsShown();
  assert(
    enabledOnly.length > 0 && enabledOnly.every((card) => card.on),
    `Enabled shows only what is on (${enabledOnly.map((c) => c.name)})`,
  );
  await dashboard.check('[data-filter="source"][value="premid"]');
  const premidOn = await cardsShown();
  assert(
    premidOn.length > 0 &&
      premidOn.every((card) => card.on && card.id.startsWith("premid:")) &&
      premidOn.length < enabledOnly.length,
    `Enabled and PreMiD narrow to PreMiD's that are on (${premidOn.map((c) => c.name)})`,
  );
  assert(
    (await dashboard.textContent('[data-slot="filter-count"]')) === "2" &&
      dashboard.url().includes("filter=enabled%2Cpremid"),
    "the button counts the filters, and the address keeps them",
  );
  await dashboard.reload();
  await dashboard.locator(".activity-card").first().waitFor();
  await dashboard.click('[data-slot="filter-toggle"]');
  assert(
    (await dashboard.isChecked('[data-filter="status"][value="enabled"]')) &&
      (await dashboard.isChecked('[data-filter="source"][value="premid"]')) &&
      !(await dashboard.isChecked('[data-filter="source"][value="parousia"]')),
    "reloading keeps the filters",
  );
  await dashboard.uncheck('[data-filter="status"][value="enabled"]');
  await dashboard.check('[data-filter="source"][value="parousia"]');
  const everyone = await cardsShown();
  assert(
    everyone.some((c) => !c.id.startsWith("premid:")) &&
      everyone.some((c) => c.id.startsWith("premid:")),
    "Parousia's and PreMiD's together are both",
  );
  await dashboard.uncheck('[data-filter="source"][value="premid"]');
  const parousiaOnly = await cardsShown();
  assert(
    parousiaOnly.length > 0 && parousiaOnly.every((card) => !card.id.startsWith("premid:")),
    `Parousia Activities alone are the native ones (${parousiaOnly.map((c) => c.name)})`,
  );
  await dashboard.keyboard.press("Escape");
  assert(
    (await dashboard.isHidden('[data-slot="filter-menu"]')) &&
      (await dashboard.evaluate(
        () => document.activeElement?.getAttribute("data-slot") === "filter-toggle",
      )),
    "Escape closes the menu and returns to its button",
  );

  // Enable or disable all: quiet until asked for, and two steps.
  assert(await dashboard.isHidden('[data-slot="bulk"]'), "the bulk controls start out of sight");
  await dashboard.click('[data-slot="bulk-toggle"]');
  const bulk = (label) => dashboard.locator('[data-slot="bulk-body"] button', { hasText: label });
  await bulk("Disable all").click();
  assert(
    (await dashboard.textContent('[data-slot="bulk-body"]'))?.includes("Disable"),
    "Disable all asks first",
  );
  assert(
    await dashboard.evaluate(() => document.activeElement?.textContent === "Cancel"),
    "with the safe answer focused",
  );
  const beforeCancel = JSON.stringify(await states());
  await bulk("Cancel").click();
  assert(JSON.stringify(await states()) === beforeCancel, "cancelling changes nothing");
  await bulk("Disable all").click();
  await dashboard.locator('[data-slot="bulk-body"] button', { hasText: /^Disable \d/ }).click();
  await dashboard.locator('[data-slot="bulk-body"] .bulk-message').waitFor();
  const nativeIds = parousiaOnly.map((card) => card.id);
  await waitUntil(async () => {
    const now = await states();
    return nativeIds.every((native) => now[native]?.on === false);
  }, "every Parousia Activity to be off");
  assert(
    (await dashboard.textContent('[data-slot="bulk-body"] .bulk-message'))?.startsWith("Disabled"),
    "and it says what it did",
  );
  assert(
    (await cardsShown()).map((card) => card.id).join() === parousiaOnly.map((c) => c.id).join(),
    "the cards stay where they were rather than jumping as they switch",
  );
  await bulk("Enable all").click();
  const question = (await dashboard.textContent('[data-slot="bulk-body"]')) ?? "";
  assert(
    question.includes("None of them needs access to a new site"),
    `enabling ones whose sites are granted says it will not ask (${question})`,
  );
  await dashboard.locator('[data-slot="bulk-body"] button', { hasText: /^Enable \d/ }).click();
  await waitUntil(async () => {
    const now = await states();
    return nativeIds.every((native) => now[native]?.on === true);
  }, "every Parousia Activity to be on again");

  // A refusal by the browser leaves an Activity off and says so; nothing is granted silently.
  await setStates({ ...(await states()), [JUMMBOX]: { on: false } });
  await dashboard.evaluate(() => {
    chrome.permissions.request = async () => false;
  });
  await dashboard.click('[data-slot="filter-toggle"]');
  await dashboard.uncheck('[data-filter="source"][value="parousia"]');
  await dashboard.fill('[data-slot="query"]', "jummbox");
  await dashboard.locator(`.activity-card[data-activity="${JUMMBOX}"]`).waitFor();
  await bulk("Enable all").click();
  assert(
    /ask for access to \d+ sites?/.test(
      (await dashboard.textContent('[data-slot="bulk-body"]')) ?? "",
    ),
    "enabling one that reads a page warns that the browser will ask for its sites",
  );
  await dashboard.locator('[data-slot="bulk-body"] button', { hasText: /^Enable \d/ }).click();
  await dashboard.locator('[data-slot="bulk-body"] .bulk-message').waitFor();
  assert(
    (await dashboard.textContent('[data-slot="bulk-body"] .bulk-message'))?.startsWith(
      "Nothing was enabled",
    ) &&
      (await states())[JUMMBOX]?.on !== true &&
      (await dashboard.textContent(`.activity-card[data-activity="${JUMMBOX}"]`))?.includes(
        "Access declined",
      ),
    "a declined prompt leaves it off, with its card saying why",
  );
  await setStates(beforeList);

  // Overview leaves Discord-RPC-Extension to Settings once Parousia Desktop is connected.
  await openDashboard("#overview");
  await dashboard.locator('[data-slot="online"]').waitFor();
  await waitUntil(
    async () =>
      (await dashboard.textContent("#status-label"))?.includes("Connected to Parousia Desktop") ??
      false,
    "the dashboard to show Parousia Desktop connected",
  );
  assert(
    await dashboard.isHidden('[data-slot="discord-row"]'),
    "Overview does not mention Discord-RPC-Extension while Desktop is connected",
  );
  await openDashboard("#settings/platforms");
  assert(
    (await dashboard.textContent("body"))?.includes("Discord-RPC-Extension"),
    "Settings > Platforms still has it",
  );
  log(
    "Activities page: enabled first by name, filters that combine and survive a reload, enable or disable all in two steps (a declined prompt leaves it off); Overview drops Discord-RPC-Extension while connected",
  );

  // --- Layout, from a phone to an ultrawide ---
  await openDashboard("#activities");
  await dashboard.locator(".activity-card").first().waitFor();
  const columns = [];
  for (const width of [360, 768, 1280, 1920, 2560]) {
    await dashboard.setViewportSize({ width, height: 900 });
    await dashboard.waitForTimeout(250);
    const layout = await dashboard.evaluate(() => {
      const cards = [...document.querySelectorAll(".activity-card")];
      const first = cards[0]?.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        columns: new Set(
          cards
            .filter((card) => card.getBoundingClientRect().top === first?.top)
            .map((card) => card.getBoundingClientRect().left),
        ).size,
        narrowest: Math.min(...cards.map((card) => card.getBoundingClientRect().width)),
        switchesInside: cards.every((card) => {
          const box = card.getBoundingClientRect();
          const toggle = card.querySelector(".switch")?.getBoundingClientRect();
          return (
            toggle !== undefined &&
            toggle.right <= box.right &&
            toggle.left >= box.left &&
            toggle.width > 0
          );
        }),
      };
    });
    assert(layout.overflow <= 0, `no sideways scrolling at ${width}px (${layout.overflow}px over)`);
    assert(layout.switchesInside, `every card's switch is inside its card at ${width}px`);
    assert(
      width <= 400 || layout.narrowest >= 260,
      `cards aren't crowded at ${width}px (${layout.narrowest}px)`,
    );
    columns.push(layout.columns);
  }
  assert(columns[0] === 1, `one column on a phone (${columns})`);
  assert(
    columns.every((n, i) => i === 0 || n >= columns[i - 1]) && columns.at(-1) > columns[1],
    `more columns as the window widens (${columns})`,
  );
  for (const width of [360, 1280]) {
    await dashboard.setViewportSize({ width, height: 900 });
    await openDashboard("#default");
    await dashboard.locator("#default-name").waitFor();
    const overflow = await dashboard.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    assert(overflow <= 0, `the Default Activity form fits at ${width}px (${overflow}px over)`);
  }
  log(
    `layout: one column at 360px, then ${columns.slice(1).join(", ")} across tablet, laptop, desktop, and ultrawide; the Default Activity form fits a phone`,
  );
  await dashboard.close();

  // --- A subdomain the regExp takes: access asked for the whole site, so it runs ---
  await setStates({ ...(await states()), [ARCH]: { on: true } });
  const archPage = await context.newPage();
  await serve(
    archPage,
    "https://bbs.archlinux.org",
    "<!doctype html><title>Arch Linux Forums</title>",
  );
  await archPage.goto("https://bbs.archlinux.org/index.php");
  await archPage.bringToFront();
  await shown((a) => a?.details === "Browsing the forums", "Arch Linux on bbs.archlinux.org");
  assert(
    discord.handshakes.at(-1) === ARCH_CLIENT,
    `as its own Application (${discord.handshakes})`,
  );
  await archPage.close();
  log(
    "Arch Linux: asks for *.archlinux.org, and runs on bbs.archlinux.org, a subdomain its regExp takes",
  );

  // --- Turned off ---
  await guidePage.bringToFront();
  await shown(
    (a) => a?.state === "Page: Event Handling",
    "DiscordJS Guide again, its tab in front",
  );
  await setStates({ ...(await states()), [GUIDE]: { on: false } });
  await shown((a) => a === null, "nothing once it's turned off");
  log("turned off: its script stops and Discord is cleared");

  log("done");
} catch (error) {
  console.error(`--- Desktop log ---\n${desktop?.lines.slice(-40).join("\n") ?? "(not started)"}`);
  throw error;
} finally {
  await launched?.close().catch(() => {});
  await desktop?.stop();
  await discord.stop();
  await ws.cleanup();
}
