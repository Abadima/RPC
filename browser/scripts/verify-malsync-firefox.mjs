// End-to-end check of the MAL-Sync integration in the Firefox installed on
// this machine (Developer Edition, over WebDriver BiDi; see e2e/firefox.mjs),
// with Parousia Desktop and a stand-in Discord.
//
// MAL-Sync itself needs its account and real streaming sites, so a stand-in
// extension takes its place under MAL-Sync's published Firefox id: its
// background is the shipped build's `onMessageExternal` handler as it is (a
// relay to the tab's content script), and its content script answers like
// `syncPage.ts`'s `presence` on an episode page and with `{}` elsewhere. What
// this checks is the browser's part: a cross-extension message from
// Parousia's event page reaching another extension, its reply coming back,
// and the reply reaching Discord through Desktop.
//
// Covers: MAL-Sync's reply shown as the Activity under its own Discord
// Application, with nothing of the page's address in it; the switch in
// Settings turning it on and off; a page it has nothing for showing nothing
// and then being left alone; and MAL-Sync not being installed at all.
//
// It runs in a private network namespace (`unshare -rn`, with its own
// loopback), so port 57179 is free whatever is running here. BiDi can't
// intercept requests, so pages come from a local HTTP proxy that answers for
// any host.
//
// Prerequisites: `cargo build` in ../desktop (or PAROUSIA_DESKTOP_BIN) and
// Firefox Developer Edition at /opt/firefox (or FIREFOX_BIN). Linux only.

import { execFile, spawnSync } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
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
  sleep,
  startDesktop,
  waitUntil,
  workspace,
} from "./e2e/lib.mjs";

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

const log = logger("malsync-firefox");
const run = promisify(execFile);

const PAROUSIA_ID = "parousia@abadima.dev";
const PAROUSIA_UUID = "8d7c6b5a-4e3f-4a2b-9c1d-0e1f2a3b4c5d";
const EXTENSION = `moz-extension://${PAROUSIA_UUID}`;
/** MAL-Sync's id on addons.mozilla.org (compat/malsync.ts). */
const MALSYNC_ID = "{c84d89d9-a826-4015-957b-affebd9eb603}";
const MALSYNC_UUID = "1f2e3d4c-5b6a-4789-8a9b-0c1d2e3f4a5b";
const MALSYNC_CLIENT = "606504719212478504";
const EPISODE = "http://stream.example/watch/frieren/3?token=secret";
const BROWSE = "http://stream.example/browse";

const MALSYNC_MANIFEST = {
  manifest_version: 3,
  name: "MAL-Sync stand-in",
  version: "0.0.1",
  browser_specific_settings: { gecko: { id: MALSYNC_ID } },
  background: { scripts: ["background.js"] },
  host_permissions: ["*://stream.example/*"],
  content_scripts: [{ matches: ["*://stream.example/*"], js: ["content.js"] }],
};

/** The shipped 0.12.5 build's handler, unminified: no check of who asks, a relay to the tab. */
const MALSYNC_BACKGROUND = `chrome.runtime.onMessageExternal.addListener(function (request, sender, sendResponse) {
  chrome.tabs.sendMessage(request.tab, { action: "presence", data: request.info }, function (response) {
    sendResponse(response);
  });
  return true;
});
`;

/** `syncPage.ts`'s presence on an episode (its shape, for a made-up series), and "nothing" elsewhere. The title counts the questions asked. */
const MALSYNC_CONTENT = `let asked = 0;
chrome.runtime.onMessage.addListener(function (info, sender, sendResponse) {
  if (info.action !== "presence") return;
  asked++;
  document.title = "asked " + asked;
  if (!location.pathname.startsWith("/watch/")) {
    sendResponse({});
    return;
  }
  sendResponse({
    clientId: ${JSON.stringify(MALSYNC_CLIENT)},
    presence: {
      details: "Sousou no Frieren",
      state: "Episode 3/28",
      largeImageKey: "https://cdn.myanimelist.net/images/anime/1015/138006.jpg",
      largeImageText: "MAL-Sync",
      smallImageKey: "play",
      smallImageText: "Playing",
      startTimestamp: Date.now() - 60000,
      endTimestamp: Date.now() + 1380000,
      buttons: [
        { label: "View Anime", url: "https://myanimelist.net/anime/52991" },
        { label: "Watch", url: location.href },
      ],
      instance: true,
      type: 3,
    },
  });
});
`;

const ws = await workspace("pavm");
const discord = await startFakeDiscord(ws.discordDir);
const shown = (check, description, timeoutMs) => discord.waitFor(check, description, timeoutMs);
let desktop;
let firefox;
let proxy;

async function pack(directory, xpi) {
  await run(
    "bun",
    [
      "-e",
      `import { writeZip } from "./scripts/zip.ts"; await writeZip(${JSON.stringify(directory)}, ${JSON.stringify(xpi)});`,
    ],
    { cwd: browserDir },
  );
}

try {
  // --- Parousia as built, and the stand-in ---
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
  await pack(join(dist, "firefox"), parousiaXpi);
  const standIn = join(ws.dir, "malsync");
  await mkdir(standIn);
  await writeFile(join(standIn, "manifest.json"), JSON.stringify(MALSYNC_MANIFEST, null, 2));
  await writeFile(join(standIn, "background.js"), MALSYNC_BACKGROUND);
  await writeFile(join(standIn, "content.js"), MALSYNC_CONTENT);
  const malsyncXpi = join(ws.dir, "malsync.xpi");
  await pack(standIn, malsyncXpi);

  proxy = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<!doctype html><title>Stream</title><video></video>");
  });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = proxy.address().port;

  desktop = startDesktop(ws);
  await desktop.waitFor(/listening on 127\.0\.0\.1:57179/);
  await control(ws, "allow", EXTENSION);

  /** Firefox with Parousia, and MAL-Sync's stand-in when `withMalSync`. */
  async function launch(withMalSync) {
    const profileDir = join(ws.dir, withMalSync ? "firefox-with" : "firefox-without");
    await prepareProfile(profileDir, [
      { id: PAROUSIA_ID, xpi: parousiaXpi, uuid: PAROUSIA_UUID },
      ...(withMalSync ? [{ id: MALSYNC_ID, xpi: malsyncXpi, uuid: MALSYNC_UUID }] : []),
    ]);
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
    const instance = await launchFirefox({ profileDir, env: ws.env });
    const ext = await instance.openTab(`${EXTENSION}/popup.html`);
    return { instance, ext };
  }
  const setPreferences = (ext, malSync) =>
    firefox.evaluate(
      ext,
      `browser.storage.local.set({ preferences: { discordRpcExtension: false, malSync: ${malSync} } })`,
    );
  const asked = (tab) =>
    firefox.evaluate(tab, `Number(/^asked (\\d+)$/.exec(document.title)?.[1] ?? 0)`);

  // --- Off, which is how it starts: MAL-Sync is never asked ---
  const first = await launch(true);
  firefox = first.instance;
  const version = (await run(FIREFOX_BINARY, ["--version"])).stdout.trim();
  await setPreferences(first.ext, false);
  const idle = await firefox.openTab(EPISODE);
  await sleep(5000);
  assert((await asked(idle)) === 0, "switched off, MAL-Sync is never asked");
  assert(
    discord.activities.every((activity) => activity === null),
    `and nothing is shown (${JSON.stringify(discord.activities)})`,
  );
  log(`${version}: with MAL-Sync's stand-in installed and the switch off, nothing is asked`);

  // --- On: its reply is the Activity ---
  await setPreferences(first.ext, true);
  const episode = await shown(
    (activity) => activity?.details === "Sousou no Frieren",
    "MAL-Sync's episode, asked for through the browser",
  );
  assert(
    discord.handshakes.at(-1) === MALSYNC_CLIENT,
    `as MAL-Sync's own Application (${discord.handshakes})`,
  );
  assert(episode.state === "Episode 3/28" && episode.type === 3, `Watching, with its episode`);
  const links = JSON.stringify(episode.buttons ?? []);
  assert(links.includes("myanimelist.net/anime/52991"), `its View Anime button stays (${links})`);
  assert(
    !JSON.stringify(episode).includes("stream.example") &&
      !JSON.stringify(episode).includes("secret"),
    `with nothing of the page's address: not its own link, not its token (${JSON.stringify(episode)})`,
  );
  log(
    "MAL-Sync's reply reaches Discord through Desktop as its own Application, without the page's address",
  );

  // --- While it has something, it's asked again every 15 seconds ---
  await waitUntil(async () => (await asked(idle)) >= 3, "MAL-Sync to be asked again", 40_000);
  log("and it keeps being asked while it has something to show");

  // --- Off again ---
  await setPreferences(first.ext, false);
  await shown((activity) => activity === null, "nothing, with the switch off again");
  log("the switch turns it off at once");

  // --- A page it has nothing for: asked a few times, then left alone ---
  await setPreferences(first.ext, true);
  await shown((activity) => activity?.details === "Sousou no Frieren", "the episode again");
  await firefox.closeTab(idle);
  const browse = await firefox.openTab(BROWSE);
  await shown((activity) => activity === null, "nothing on a page it has nothing for");
  // Each question the page sees, by time: its title counts them. The first is sent while the
  // page's script isn't there yet and gets no answer, so three or four arrive, all within 25 s.
  const began = Date.now();
  const times = [];
  while (Date.now() - began < 60_000) {
    const count = await asked(browse);
    if (count > times.length) times.push(Math.round((Date.now() - began) / 1000));
    await sleep(500);
  }
  assert(
    times.length >= 3 && times.length <= 4 && (times.at(-1) ?? 99) <= 30,
    `a page it has nothing for is asked a few times, then left alone (seen at ${times} s)`,
  );
  log(`a page it has nothing for is asked a few times (seen at ${times} s), then not at all`);
  await firefox.closeTab(browse);
  await firefox.close();
  firefox = undefined;

  // --- Not installed ---
  const second = await launch(false);
  firefox = second.instance;
  await setPreferences(second.ext, true);
  const before = discord.activities.length;
  await firefox.openTab(EPISODE);
  await sleep(8000);
  assert(
    discord.activities.slice(before).every((activity) => activity === null),
    `with no MAL-Sync installed it just shows nothing (${JSON.stringify(discord.activities.slice(before))})`,
  );
  const state = await firefox.evaluate(
    second.ext,
    `browser.runtime.getPlatformInfo().then((info) => typeof info.os)`,
  );
  assert(state === "string", "and Parousia carries on");
  log("with MAL-Sync not installed, the question fails quietly and nothing is shown");

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
