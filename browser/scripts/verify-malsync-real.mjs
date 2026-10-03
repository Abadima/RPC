// End-to-end check of MAL-Sync support against the real MAL-Sync and the real
// Discord-RPC-Extension (its extension and its app, `server.js`), in
// Chromium (playwright-core's) and the Firefox installed on this machine
// (Developer Edition, over WebDriver BiDi; see e2e/firefox.mjs), with the
// Parousia Desktop build and stand-ins for Discord. Run
// `bun run real-extensions:fetch` once first: it caches the store builds.
//
// MAL-Sync recognizes a page by its own rules, so the page is the one
// MAL-Sync's AnimeOdcinki page expects (anime-odcinki.pl/anime/<series>/<n>,
// with the series title in a `.field-name-field-tytul-anime` link), served by
// the test. Its services aren't reachable (there's no network here), so
// MAL-Sync shows the episode as a "Local" entry: its own fallback, and the
// same presence code path as for a series it found.
//
// Three sessions per browser, each asking what the real pieces do:
//
// 1. Beside Discord-RPC-Extension (Desktop, Parousia, MAL-Sync, Discord-RPC-
//    Extension and its app): MAL-Sync reaches Discord through Discord-RPC-
//    Extension by itself, Parousia (with MAL-Sync support off) neither sees
//    nor can limit that and shows its own Activity next to it, and with
//    MAL-Sync support on, its reply is Parousia's Activity, under Parousia's
//    Privacy choices, whether or not MAL-Sync's own Discord setting is on.
// 2. Without Discord-RPC-Extension (Desktop, Parousia, MAL-Sync): MAL-Sync
//    has nowhere to show until MAL-Sync support is on.
// 3. Without Parousia Desktop (Parousia's link to Discord-RPC-Extension's
//    app, MAL-Sync, Discord-RPC-Extension): the app has one presence slot,
//    which Parousia's own Activity and MAL-Sync's take from each other,
//    until MAL-Sync support makes them one.
//
// It runs in a private network namespace (`unshare -rn`, with its own
// loopback), so ports 57179 and 6969 are free whatever is running here, and
// a real Discord-RPC-Extension app is never touched.
//
// `MALSYNC_BROWSER=chromium` or `firefox` runs one browser.
//
// Prerequisites: `bun run real-extensions:fetch`, `cargo build` in ../desktop
// (or PAROUSIA_DESKTOP_BIN), `bun run chromium:setup` for Chromium, Firefox
// Developer Edition at /opt/firefox (or FIREFOX_BIN) for Firefox. Linux only.

import { execFile, spawn, spawnSync } from "node:child_process";
import { appendFile, cp, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright-core";
import { startFakeDiscord } from "./e2e/fake-discord.mjs";
import { launchFirefox, prepareProfile } from "./e2e/firefox.mjs";
import {
  PAROUSIA_CLIENT_ID,
  assert,
  browserDir,
  control,
  logger,
  sleep,
  startDesktop,
  track,
  workspace,
} from "./e2e/lib.mjs";
import { CHROME_IDS, FIREFOX_IDS, realExtensions } from "./e2e/real-extensions.mjs";

if (process.env.PAROUSIA_NETNS !== "1") {
  const again = spawnSync(
    "unshare",
    [
      "-rn",
      "sh",
      "-c",
      'ip link set lo up && exec "$0" "$@"',
      process.execPath,
      ...process.argv.slice(1),
    ],
    { stdio: "inherit", env: { ...process.env, PAROUSIA_NETNS: "1" } },
  );
  process.exit(again.status ?? 1);
}

const log = logger("malsync-real");
const run = promisify(execFile);
const real = await realExtensions();

const MALSYNC_CLIENT = "606504719212478504";
const PAGE_URL = "http://anime-odcinki.pl/anime/frieren/3";
const PAGE_HTML = `<!doctype html><title>Frieren 3</title><body>
<div class="field-name-field-tytul-anime"><a href="/anime/frieren">Sousou no Frieren</a></div>
<div class="view-content"></div><a id="video-next" href="/anime/frieren/4">next</a><video></video></body>`;
const PAROUSIA_UUID = "8d7c6b5a-4e3f-4a2b-9c1d-0e1f2a3b4c5d";
const UUIDS = {
  malsync: "1f2e3d4c-5b6a-4789-8a9b-0c1d2e3f4a5b",
  dre: "2a3b4c5d-6e7f-4890-9abc-1d2e3f4a5b6c",
};

const ws = await workspace("pavr");
const browsers = (process.env.MALSYNC_BROWSER ?? "chromium,firefox").split(",");

/** What a stand-in Discord has shown, for a failure's report. */
const summary = (discord) =>
  discord.calls.map(
    ({ clientId, activity }) => `${clientId?.slice(0, 4)}:${activity?.name ?? "-"}`,
  );

// --- Parousia, built once ---
const dist = join(ws.dir, "dist");
await run("bun", ["run", "build.ts"], {
  cwd: browserDir,
  env: {
    ...process.env,
    PAROUSIA_ACTIVITIES_DIR: join(browserDir, "scripts", "activities", "fixtures", "parousia"),
    PAROUSIA_BUILD_DIR: dist,
  },
});
const parousiaXpi = join(ws.dir, "parousia.xpi");
await run(
  "bun",
  [
    "-e",
    `import { writeZip } from "./scripts/zip.ts"; await writeZip(${JSON.stringify(join(dist, "firefox"))}, ${JSON.stringify(parousiaXpi)});`,
  ],
  { cwd: browserDir },
);
const parousiaChromium = join(ws.dir, "parousia-chromium");
await cp(join(dist, "chromium"), parousiaChromium, { recursive: true });

// --- The two ways to run a browser, behind one shape ---

/** Pages for Firefox: a proxy that answers for any host (BiDi can't intercept requests). */
async function startProxy() {
  const proxy = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://unknown");
    const ours = url.hostname === "anime-odcinki.pl" && url.pathname.startsWith("/anime/");
    response.writeHead(ours ? 200 : 404, { "content-type": "text/html" });
    response.end(ours ? PAGE_HTML : "");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  return proxy;
}

async function launchChromium({ dre, dir }) {
  const extensions = [parousiaChromium, real.chrome.malsync, ...(dre ? [real.chrome.dre] : [])];
  const context = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${extensions.join(",")}`,
      `--load-extension=${extensions.join(",")}`,
    ],
  });
  await context.route("http://anime-odcinki.pl/**", (route) =>
    route.fulfill({ contentType: "text/html", body: PAGE_HTML }),
  );
  /** An extension's own page, for running code with its APIs. */
  const inside = async (id, path) => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/${path}`);
    return (expression) => page.evaluate(expression);
  };
  const worker =
    context.serviceWorkers().find((w) => w.url().endsWith("/chromium.js")) ??
    (await context.waitForEvent("serviceworker", { timeout: 20_000 }));
  const parousiaId = new URL(worker.url()).host;
  return {
    name: `Chromium ${context.browser()?.version() ?? ""}`.trim(),
    malsyncId: CHROME_IDS.malsync,
    origin: `chrome-extension://${parousiaId}`,
    parousia: await inside(parousiaId, "popup.html"),
    malsync: await inside(CHROME_IDS.malsync, "install.html"),
    async open(url) {
      const page = await context.newPage();
      await page.goto(url);
      await page.bringToFront();
      return page;
    },
    close: (page) => page.close(),
    stop: () => context.close(),
  };
}

async function launchFirefoxWith({ dre, dir }) {
  const proxy = await startProxy();
  const extensions = [
    { id: "parousia@abadima.dev", xpi: parousiaXpi, uuid: PAROUSIA_UUID },
    { id: FIREFOX_IDS.malsync, xpi: real.firefox.malsync, uuid: UUIDS.malsync },
    ...(dre ? [{ id: FIREFOX_IDS.dre, xpi: real.firefox.dre, uuid: UUIDS.dre }] : []),
  ];
  await prepareProfile(dir, extensions);
  await appendFile(
    join(dir, "user.js"),
    `\n${Object.entries({
      "network.proxy.type": 1,
      "network.proxy.http": "127.0.0.1",
      "network.proxy.http_port": proxy.address().port,
      "network.proxy.share_proxy_settings": false,
      "dom.security.https_first": false,
      "dom.security.https_only_mode": false,
    })
      .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`)
      .join("\n")}\n`,
  );
  const firefox = await launchFirefox({ profileDir: dir, env: ws.env });
  const parousia = await firefox.openTab(`moz-extension://${PAROUSIA_UUID}/popup.html`);
  const malsync = await firefox.openTab(`moz-extension://${UUIDS.malsync}/install.html`);
  return {
    name: "Firefox",
    malsyncId: FIREFOX_IDS.malsync,
    origin: `moz-extension://${PAROUSIA_UUID}`,
    parousia: (expression) => firefox.evaluate(parousia, expression),
    malsync: (expression) => firefox.evaluate(malsync, expression),
    open: (url) => firefox.openTab(url),
    close: (tab) => firefox.closeTab(tab),
    async stop() {
      await firefox.close();
      proxy.close();
    },
  };
}

// --- A session: the pieces it needs, started fresh, and stopped after ---

/** Discord-RPC-Extension's own app, the real `server.js`, showing on its own stand-in Discord. */
function startDreApp(discordDir) {
  const child = track(
    spawn("node", ["server.js"], {
      cwd: real.app,
      env: { ...process.env, XDG_RUNTIME_DIR: discordDir },
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const lines = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => lines.push(...chunk.toString().split("\n").filter(Boolean)));
  }
  return { lines, stop: () => child.kill() };
}

async function session(title, { kind, dre, desktop }, body) {
  const desk = await startFakeDiscord(ws.discordDir);
  const appDir = join(ws.dir, `app-discord-${title.replace(/\W+/g, "-")}`);
  await mkdir(appDir, { mode: 0o700 });
  const app = await startFakeDiscord(appDir);
  const dreApp = dre ? startDreApp(appDir) : null;
  const dreText = dre
    ? " with Discord-RPC-Extension and its app"
    : " with no Discord-RPC-Extension";
  let host;
  let browser;
  try {
    if (desktop) {
      host = startDesktop(ws);
      await host.waitFor(/listening on 127\.0\.0\.1:57179/);
    }
    if (desktop && kind === "firefox")
      await control(ws, "allow", `moz-extension://${PAROUSIA_UUID}`);
    const dir = join(ws.dir, `${kind}-${title.replace(/\W+/g, "-")}`);
    browser = await (kind === "chromium" ? launchChromium : launchFirefoxWith)({ dre, dir });
    if (desktop) {
      // Firefox's origin is fixed, and allowed before it starts; Chromium's isn't known until it has loaded.
      await control(ws, "allow", browser.origin);
      await browser.parousia(
        `(() => { chrome.runtime.connect({ name: "parousia-ui" }).postMessage({ type: "reconnect" }); return true; })()`,
      );
    }
    const state = { preferences: { discordRpcExtension: false, malSync: false } };
    const context = {
      desk,
      app,
      browser,
      say: (text) => log(`${browser.name}${dreText}: ${text}`),
      /** Parousia's preferences, with `patch` on top of what was set before. */
      async prefs(patch) {
        Object.assign(state.preferences, patch);
        await browser.parousia(
          `chrome.storage.local.set({ preferences: ${JSON.stringify(state.preferences)} })`,
        );
      },
      defaultActivity: (value) =>
        browser.parousia(`chrome.storage.local.set({ defaultActivity: ${JSON.stringify(value)} })`),
      /** MAL-Sync's own settings (it keeps them in sync storage). */
      malsyncSetting: (key, value) =>
        browser.malsync(
          `chrome.storage.sync.set({ ${JSON.stringify(`settings/${key}`)}: ${JSON.stringify(value)} })`,
        ),
      /** The last thing each stand-in Discord was sent, or null. */
      last: (discord) => discord.activities.at(-1) ?? null,
    };
    await body(context);
  } catch (error) {
    console.error(
      `--- ${title} (${kind}) ---\nDesktop:\n${host?.lines.slice(-25).join("\n") ?? "(not running)"}` +
        `\nDiscord-RPC-Extension's app:\n${dreApp?.lines.slice(-25).join("\n") ?? "(not running)"}` +
        `\nDesktop's Discord: ${JSON.stringify(summary(desk))}\nThe app's Discord: ${JSON.stringify(summary(app))}`,
    );
    // What Parousia's own page sees: the tabs, and MAL-Sync's answer to a question put to it directly.
    const asking = await browser
      ?.parousia(
        `(async () => {
          const tabs = await chrome.tabs.query({});
          const page = tabs.find((tab) => tab.url?.includes("anime-odcinki"));
          const reply = page
            ? await new Promise((resolve) =>
                chrome.runtime.sendMessage(
                  ${JSON.stringify(browser.malsyncId)},
                  { tab: page.id, info: { action: "presence", active: true } },
                  (answer) => resolve({ answer, error: chrome.runtime.lastError?.message }),
                ),
              )
            : null;
          return { tabs: tabs.map(({ id, url, active, windowId }) => ({ id, url, active, windowId })), reply };
        })()`,
      )
      .catch((problem) => `(${problem.message})`);
    console.error(`Parousia's page: ${JSON.stringify(asking)}`);
    throw error;
  } finally {
    await browser?.stop().catch(() => {});
    dreApp?.stop();
    await host?.stop();
    await app.stop();
    await desk.stop();
  }
}

/** Waits for a stand-in Discord to be showing something that passes `check`. */
const shows = (discord, check, description, timeoutMs = 45_000) =>
  discord.waitFor(check, description, timeoutMs);
const episode = (activity) => activity?.name === "Sousou no Frieren";

/** The whole of what's been sent to `discord` since `from`, none of it an activity. */
const quietSince = (discord, from) => discord.activities.slice(from).every((a) => a === null);

try {
  for (const kind of browsers) {
    // --- 1. Beside Discord-RPC-Extension ---
    await session("beside", { kind, dre: true, desktop: true }, async (t) => {
      await t.prefs({});
      const page = await t.browser.open(PAGE_URL);

      const own = await shows(t.app, episode, "MAL-Sync's episode through Discord-RPC-Extension");
      assert(
        own.type === 3 && own.state === "Episode: 3" && own.assets?.large_image === "malsync",
        `its own route carries it as MAL-Sync built it (${JSON.stringify(own)})`,
      );
      assert(
        t.app.calls.at(-1)?.clientId === MALSYNC_CLIENT,
        "under MAL-Sync's own Discord Application",
      );
      assert(quietSince(t.desk, 0), "and Parousia, with MAL-Sync support off, shows nothing");
      t.say(
        "MAL-Sync reaches Discord through Discord-RPC-Extension alone; Parousia has nothing of it",
      );

      // Parousia's own Activity, next to it: two presences nobody coordinates.
      await t.defaultActivity({ enabled: true, name: "Browsing", details: "Somewhere" });
      await shows(t.desk, (a) => a?.name === "Browsing", "Parousia's Default Activity");
      assert(episode(t.last(t.app)), "while MAL-Sync's is still up through Discord-RPC-Extension");
      t.say("Parousia's Activity and MAL-Sync's show side by side, as two separate presences");

      // MAL-Sync support on: its reply is Parousia's Activity for the page.
      await t.prefs({ malSync: true });
      const direct = await shows(t.desk, episode, "MAL-Sync's episode through Parousia Desktop");
      assert(
        direct.type === 3 &&
          direct.state === "Episode: 3" &&
          direct.assets?.large_image === "malsync",
        `the same episode (${JSON.stringify(direct)})`,
      );
      assert(t.desk.calls.at(-1)?.clientId === MALSYNC_CLIENT, "as MAL-Sync's Application");
      assert(
        episode(t.last(t.app)),
        "and, with MAL-Sync's own Discord setting on, again through the app",
      );
      t.say("with MAL-Sync support on it is Parousia's Activity, replacing the Default one");

      // Privacy: Parousia's choices reach its own route, not Discord-RPC-Extension's.
      await t.prefs({ shareMediaDetails: false });
      const limited = await shows(t.desk, (a) => a?.name === "MAL-Sync", "only MAL-Sync's name");
      assert(
        limited.state === undefined && limited.details === undefined,
        `without the episode (${JSON.stringify(limited)})`,
      );
      await sleep(16_000);
      assert(
        episode(t.last(t.app)),
        "while Discord-RPC-Extension's route still names the series, which Parousia can't limit",
      );
      t.say(
        "Share Media Details off limits Parousia's route; Discord-RPC-Extension's still shows the title",
      );

      // MAL-Sync's own Discord setting off ends the duplicate; Parousia still gets it.
      await t.prefs({ shareMediaDetails: true });
      await t.browser.close(page);
      await shows(t.app, (a) => a === null, "Discord-RPC-Extension's route cleared with the tab");
      await t.malsyncSetting("rpc", false);
      const again = t.app.activities.length;
      const reopened = await t.browser.open(PAGE_URL);
      await shows(t.desk, episode, "MAL-Sync's episode again, through Parousia Desktop");
      await sleep(20_000);
      assert(
        quietSince(t.app, again),
        `with MAL-Sync's Discord setting off Discord-RPC-Extension is silent (${JSON.stringify(summary(t.app).slice(again))})`,
      );
      assert(
        episode(t.last(t.desk)),
        "and Parousia still has MAL-Sync's episode: its answer doesn't depend on that setting",
      );
      t.say(
        "with MAL-Sync's own Discord setting off, only Parousia's route shows, so it is shown once",
      );
      await t.browser.close(reopened);
    });

    // --- 2. Without Discord-RPC-Extension ---
    await session("alone", { kind, dre: false, desktop: true }, async (t) => {
      await t.prefs({});
      const page = await t.browser.open(PAGE_URL);
      await sleep(25_000);
      assert(
        quietSince(t.desk, 0),
        `with MAL-Sync support off and no Discord-RPC-Extension, nothing shows (${JSON.stringify(summary(t.desk))})`,
      );
      t.say("MAL-Sync has nowhere to show");
      await t.prefs({ malSync: true });
      const direct = await shows(t.desk, episode, "MAL-Sync's episode through Parousia Desktop");
      assert(
        direct.state === "Episode: 3",
        `with MAL-Sync support on it shows (${JSON.stringify(direct)})`,
      );
      t.say("with MAL-Sync support on, the episode shows through Parousia Desktop");
      await t.browser.close(page);
    });

    // --- 3. Without Parousia Desktop ---
    await session("bridge", { kind, dre: true, desktop: false }, async (t) => {
      await t.prefs({ discordRpcExtension: true });
      await t.defaultActivity({ enabled: true, name: "Browsing", details: "Somewhere" });
      const page = await t.browser.open(PAGE_URL);
      await shows(t.app, episode, "MAL-Sync's episode through Discord-RPC-Extension", 60_000);
      await sleep(50_000);
      const clients = new Set(
        t.app.calls.filter(({ activity }) => activity).map(({ clientId }) => clientId),
      );
      const trace = summary(t.app);
      assert(
        clients.has(MALSYNC_CLIENT) && clients.has(PAROUSIA_CLIENT_ID),
        `Parousia's Activity and MAL-Sync's both reach the app (${JSON.stringify(trace)})`,
      );
      const swaps = trace.filter((item, i) => item !== trace[i - 1]).length;
      t.say(
        `the app has one presence slot and the two take it from each other (${swaps} changes in a minute: ${trace.slice(-8).join(", ")})`,
      );

      await t.browser.close(page);
      await t.malsyncSetting("rpc", false);
      await t.prefs({ malSync: true });
      await sleep(5000);
      const from = t.app.calls.length;
      const reopened = await t.browser.open(PAGE_URL);
      await shows(
        t.app,
        (a) => episode(a),
        "MAL-Sync's episode through Parousia's own link",
        60_000,
      );
      await sleep(40_000);
      const since = t.app.calls.slice(from).filter(({ activity }) => activity);
      assert(
        since.length > 0 &&
          since.every(({ clientId, activity }) => clientId === MALSYNC_CLIENT && episode(activity)),
        `with MAL-Sync support on, one presence, MAL-Sync's (${JSON.stringify(summary(t.app).slice(from))})`,
      );
      t.say(
        "with MAL-Sync support on and MAL-Sync's own Discord setting off, the app gets one steady presence",
      );
      await t.browser.close(reopened);
    });
  }
  const { versions } = real;
  log(
    `done (MAL-Sync ${versions["malsync-chrome"]}, Discord-RPC-Extension ${versions["dre-chrome"]})`,
  );
} finally {
  await ws.cleanup();
}
