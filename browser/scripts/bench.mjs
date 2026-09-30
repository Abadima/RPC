// What Parousia costs on this machine, measured with real processes, so a
// change's effect on size, memory, CPU, and latency is a number rather than
// a guess. Prints a table and writes the numbers as JSON (BENCH_OUT).
//
// - Sizes: each extension build, Firefox's zip, the userscript, the largest
//   bundles and packaged files, Desktop's release binary.
// - Desktop (release, headless): time until it answers, then memory,
//   threads, CPU time, and wakeups while idle, with three clients connected,
//   and with them publishing; how long a Presence takes to reach Discord (a
//   stand-in, e2e/fake-discord.mjs).
// - The extension in playwright-core's Chromium, with the fixture native
//   Activities and real PreMiD ones: the background's heap and its process's
//   memory and CPU while idle and while sharing a native and a PreMiD
//   Activity; how long a detected Activity takes to reach Discord; how long
//   the popup and the dashboard's Activities page take to show.
//
// CPU is kernel-accounted time (utime + stime from /proc). Playwright stays
// attached to the background, which keeps Chromium from stopping it, so
// "idle" here means running with nothing to do, not stopped.
//
// Env: BENCH_DIST (an extension build including the fixture Activities;
// default: builds one into a temporary folder), PAROUSIA_DESKTOP_BIN
// (default: ../desktop/target/release/Parousia-Desktop), BENCH_SECONDS (each
// measuring window, default 20), BENCH_OUT (a JSON file to write).
// Linux only; needs `bun run activities:fetch`, `cargo build --release` in
// ../desktop, and a free port 57179.

import { chromium } from "playwright-core";
import { execFile, spawn } from "node:child_process";
import { cp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const release = join(import.meta.dirname, "..", "..", "desktop", "target", "release");
process.env.PAROUSIA_DESKTOP_BIN ??= join(release, "Parousia-Desktop");

const { startFakeDiscord } = await import("./e2e/fake-discord.mjs");
const { connectRaw } = await import("./e2e/raw-ws.mjs");
const { browserDir, control, desktopBinary, sleep, track, waitUntil, workspace } =
  await import("./e2e/lib.mjs");

const run = promisify(execFile);
const SECONDS = Number(process.env.BENCH_SECONDS ?? 20);
const CDP_PORT = 9335;
const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const GUIDE = "premid:DiscordJS Guide";
const TUNES_PAGE = "https://tunes.example/listen/1";
const GUIDE_PAGE = "https://discordjs.guide/creating-your-bot/slash-commands";

const results = {
  at: new Date().toISOString(),
  seconds: SECONDS,
  sizes: {},
  desktop: {},
  extension: {},
};
const kb = (bytes) => Math.round(bytes / 102.4) / 10;

/** Like waitUntil, polling every 5 ms, since what's measured here is latency. */
async function until(check, description, timeoutMs = 20_000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (await check()) return;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${description}`);
}
/** Until Discord (the stand-in) last showed something passing `check`. */
const shows = (discord, check, description) =>
  until(() => discord.activities.length > 0 && check(discord.activities.at(-1)), description);

// --- /proc ---

async function proc(pid) {
  const raw = await readFile(`/proc/${pid}/stat`, "utf8");
  const fields = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
  const status = await readFile(`/proc/${pid}/status`, "utf8");
  const field = (text, key) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text)?.[1] ?? 0);
  // Per thread: time on CPU in nanoseconds, and context switches (a thread waking up).
  const threads = new Map();
  for (const task of await readdir(`/proc/${pid}/task`).catch(() => [])) {
    const [schedstat, taskStatus] = await Promise.all([
      readFile(`/proc/${pid}/task/${task}/schedstat`, "utf8").catch(() => "0"),
      readFile(`/proc/${pid}/task/${task}/status`, "utf8").catch(() => ""),
    ]);
    threads.set(task, {
      ns: Number(schedstat.split(" ")[0]),
      switches:
        field(taskStatus, "voluntary_ctxt_switches") +
        field(taskStatus, "nonvoluntary_ctxt_switches"),
    });
  }
  return {
    ppid: Number(fields[1]),
    rssKb: field(status, "VmRSS"),
    threads,
  };
}

/** CPU time, wakeups, and memory of `pids()` over `seconds`. */
async function measure(pids, seconds = SECONDS) {
  const sample = async () => {
    const list = await pids();
    const stats = await Promise.all(list.map((pid) => proc(pid).catch(() => null)));
    return new Map(list.map((pid, i) => [pid, stats[i]]).filter(([, s]) => s));
  };
  const before = await sample();
  await sleep(seconds * 1000);
  const after = await sample();
  let ns = 0;
  let switches = 0;
  let rssKb = 0;
  let threads = 0;
  for (const [pid, end] of after) {
    const start = before.get(pid);
    for (const [task, now] of end.threads) {
      const then = start?.threads.get(task);
      ns += now.ns - (then?.ns ?? 0);
      switches += now.switches - (then?.switches ?? 0);
    }
    rssKb += end.rssKb;
    threads += end.threads.size;
  }
  const cpuMs = ns / 1e6;
  return {
    cpuMs: Math.round(cpuMs * 10) / 10,
    cpuPercent: Math.round((cpuMs / (seconds * 1000)) * 10000) / 100,
    wakeupsPerSecond: Math.round((switches / seconds) * 10) / 10,
    rssMb: Math.round(rssKb / 102.4) / 10,
    threads,
    processes: after.size,
  };
}

/** `root` and every process under it. */
async function tree(root) {
  const parents = new Map();
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const info = await proc(Number(name)).catch(() => null);
    if (info) parents.set(Number(name), info.ppid);
  }
  const found = new Set([root]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parents) {
      if (!found.has(pid) && found.has(ppid)) {
        found.add(pid);
        grew = true;
      }
    }
  }
  return [...found];
}

async function cmdline(pid) {
  return readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
}

// --- Sizes ---

async function folderSize(dir) {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    bytes += (await stat(join(entry.parentPath, entry.name))).size;
    files += 1;
  }
  return { bytes, files };
}

async function sizes(dist) {
  const size = async (path) => (await stat(path).catch(() => null))?.size ?? null;
  const out = {};
  for (const target of ["chromium", "firefox"]) out[target] = await folderSize(join(dist, target));
  out["firefox.zip"] = await size(join(dist, "firefox.zip"));
  out.userscript = await size(join(dist, "userscript", "parousia.user.js"));
  const files = {};
  for (const file of [
    "chromium.js",
    "popup.js",
    "fullscreen.js",
    "activities/catalog.json",
    "activities/index.json",
    "activities/collector.js",
    "activities/premid/runtime.js",
  ]) {
    files[file] = await size(join(dist, "chromium", file));
  }
  out.files = files;
  out.desktopBinary = await size(desktopBinary);
  return out;
}

// --- Desktop ---

async function health() {
  try {
    return (await fetch("http://127.0.0.1:57179/health")).ok;
  } catch {
    return false;
  }
}

async function hello(client) {
  client.sendText(
    JSON.stringify({ type: "hello", protocolVersion: PROTOCOL, name: "Bench on Linux" }),
  );
  const reply = await client.next();
  if (reply?.type !== "welcome") throw new Error(`Desktop answered ${JSON.stringify(reply)}`);
}

const PROTOCOL = Number(
  /PROTOCOL_VERSION = (\d+)/.exec(
    await readFile(join(browserDir, "src", "core", "desktop-protocol.ts"), "utf8"),
  )?.[1],
);

function presence(details) {
  const activity = { id: "bench", name: "Bench", details, state: "Measuring" };
  if (PROTOCOL < 6) activity.url = "https://example.com/";
  return JSON.stringify({ type: "presence", presence: { activity, updatedAt: Date.now() } });
}

async function benchDesktop() {
  const ws = await workspace("pbench");
  const discord = await startFakeDiscord(ws.discordDir);
  const started = performance.now();
  const child = track(spawn(desktopBinary, ["--headless"], { env: ws.env, stdio: "ignore" }));
  try {
    await waitUntil(health, "Desktop to answer", 10_000);
    results.desktop.startupMs = Math.round(performance.now() - started);
    await sleep(1000);
    const self = async () => [child.pid];
    results.desktop.idle = await measure(self);

    await control(ws, "allow", ORIGIN);
    const clients = [];
    for (let i = 0; i < 3; i++) {
      const client = await connectRaw({ origin: ORIGIN });
      await hello(client);
      clients.push(client);
    }
    results.desktop.threeClients = await measure(self);

    // First Presence: Discord isn't connected yet, so this includes connecting to it.
    let sent = performance.now();
    clients[0].sendText(presence("first"));
    await shows(discord, (a) => a?.details === "first", "the first Presence");
    results.desktop.firstPresenceMs = Math.round(performance.now() - sent);
    await sleep(5000);
    sent = performance.now();
    clients[0].sendText(presence("second"));
    await shows(discord, (a) => a?.details === "second", "a change");
    results.desktop.changeMs = Math.round(performance.now() - sent);

    // Publishing: each client changes its Presence once a second.
    let n = 0;
    const timer = setInterval(() => {
      for (const client of clients) client.sendText(presence(`update ${++n}`));
    }, 1000);
    results.desktop.publishing = await measure(self);
    clearInterval(timer);
    for (const client of clients) client.close();
  } finally {
    child.kill();
    await discord.stop();
    await ws.cleanup();
  }
}

// --- The extension ---

/** A minimal Chrome DevTools Protocol client, for what Playwright doesn't expose (the background's heap). */
async function devtools(port) {
  const { webSocketDebuggerUrl } = await (
    await fetch(`http://127.0.0.1:${port}/json/version`)
  ).json();
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let next = 0;
  const pending = new Map();
  socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    });
  return { send, close: () => socket.close() };
}

async function workerHeap(cdp, extensionId) {
  const { targetInfos } = await cdp.send("Target.getTargets");
  const target = targetInfos.find(
    (t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extensionId}/`),
  );
  if (!target) return null;
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  try {
    await cdp.send("HeapProfiler.collectGarbage", {}, sessionId);
    const { usedSize } = await cdp.send("Runtime.getHeapUsage", {}, sessionId);
    return kb(usedSize);
  } finally {
    await cdp.send("Target.detachFromTarget", { sessionId });
  }
}

async function pageHeap(context, page) {
  const session = await context.newCDPSession(page);
  await session.send("HeapProfiler.collectGarbage");
  const { usedSize } = await session.send("Runtime.getHeapUsage");
  await session.detach();
  return kb(usedSize);
}

async function benchExtension(dist) {
  const ws = await workspace("pbench");
  const discord = await startFakeDiscord(ws.discordDir);
  const desktop = track(spawn(desktopBinary, ["--headless"], { env: ws.env, stdio: "ignore" }));
  const extensionDir = join(ws.dir, "extension");
  let context;
  let cdp;
  try {
    await waitUntil(health, "Desktop to answer", 10_000);
    await cp(join(dist, "chromium"), extensionDir, { recursive: true });
    const index = JSON.parse(
      await readFile(join(extensionDir, "activities", "index.json"), "utf8"),
    );
    // Manifests are named in the index (`premid/<name>`; builds before that named the file alone).
    const file = index.files[GUIDE].includes("/")
      ? index.files[GUIDE]
      : `premid/${index.files[GUIDE]}`;
    const guide = JSON.parse(
      await readFile(join(extensionDir, "activities", `${file}.json`), "utf8"),
    );
    const manifestPath = join(extensionDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.permissions = [...manifest.permissions, "scripting"];
    manifest.host_permissions = [...guide.info.origins, "https://tunes.example/*"];
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const launched = performance.now();
    context = await chromium.launchPersistentContext(join(ws.dir, "profile"), {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        `--remote-debugging-port=${CDP_PORT}`,
      ],
    });
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker", { timeout: 20_000 }));
    results.extension.launchToBackgroundMs = Math.round(performance.now() - launched);
    const id = new URL(worker.url()).host;
    await worker.evaluate(() =>
      chrome.storage.local.set({ preferences: { discordRpcExtension: false } }),
    );
    await control(ws, "allow", `chrome-extension://${id}`);
    cdp = await devtools(CDP_PORT);

    // The browser's processes, and the one the extension's background runs in.
    const [browserPid] = (
      await Promise.all(
        (await readdir("/proc"))
          .filter((name) => /^\d+$/.test(name))
          .map(async (pid) =>
            (await cmdline(pid)).includes(join(ws.dir, "profile")) ? Number(pid) : null,
          ),
      )
    ).filter((pid) => pid !== null && !Number.isNaN(pid));
    const all = () => tree(browserPid);
    const extensionProcess = async () => {
      const pids = [];
      for (const pid of await all())
        if ((await cmdline(pid)).includes("--extension-process")) pids.push(pid);
      return pids;
    };

    const setStates = (states) =>
      worker.evaluate((activities) => chrome.storage.local.set({ activities }), states);

    await sleep(3000);
    results.extension.idle = {
      backgroundHeapKb: await workerHeap(cdp, id),
      process: await measure(extensionProcess),
    };

    // A native Activity reading its page (the collector), from navigation to Discord.
    await setStates({ tunes: { on: true } });
    await sleep(500);
    const tunes = await context.newPage();
    await tunes.route("https://tunes.example/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><title>Tunes</title><audio></audio><script>
          navigator.mediaSession.metadata = new MediaMetadata({ title: "Bench Song", artist: "Bench",
            artwork: [{ src: "https://img.example/cover.png", sizes: "512x512" }] });
        </script>`,
      }),
    );
    let started = performance.now();
    await tunes.goto(TUNES_PAGE);
    await shows(discord, (a) => a?.details === "Bench Song", "Tunes' song");
    results.extension.nativeToDiscordMs = Math.round(performance.now() - started);
    results.extension.sharingNative = {
      backgroundHeapKb: await workerHeap(cdp, id),
      process: await measure(extensionProcess),
      browser: await measure(all),
    };
    await tunes.close();

    // A PreMiD Activity: its own script ticking in the page once a second.
    await setStates({ tunes: { on: true }, [GUIDE]: { on: true } });
    await sleep(500);
    const page = await context.newPage();
    await page.route("https://discordjs.guide/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Slash commands | discord.js Guide</title><h1>Slash Commands</h1>",
      }),
    );
    started = performance.now();
    await page.goto(GUIDE_PAGE);
    await shows(discord, (a) => a?.state === "Page: Slash Commands", "DiscordJS Guide");
    results.extension.premidToDiscordMs = Math.round(performance.now() - started);
    await page.evaluate(() => {
      document.querySelector("h1").textContent = "Event Handling";
    });
    started = performance.now();
    await shows(discord, (a) => a?.state === "Page: Event Handling", "the page's change");
    results.extension.premidChangeToDiscordMs = Math.round(performance.now() - started);
    results.extension.sharingPremid = {
      backgroundHeapKb: await workerHeap(cdp, id),
      process: await measure(extensionProcess),
      browser: await measure(all),
    };

    // The popup and the dashboard, each in a tab of its own.
    const popup = await context.newPage();
    started = performance.now();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await until(
      async () => /Connected/.test((await popup.textContent("#status-label")) ?? ""),
      "the popup to show Desktop connected",
    );
    results.extension.popupReadyMs = Math.round(performance.now() - started);
    results.extension.popupHeapKb = await pageHeap(context, popup);
    await popup.close();

    const dashboard = await context.newPage();
    started = performance.now();
    await dashboard.goto(`chrome-extension://${id}/fullscreen.html#activities`);
    await dashboard.locator(".activity-card").first().waitFor();
    results.extension.activitiesReadyMs = Math.round(performance.now() - started);
    started = performance.now();
    await dashboard.fill('[data-slot="query"]', "youtube");
    await until(
      async () =>
        (await dashboard.locator(".activity-card").first().textContent())?.includes("YouTube"),
      "search results",
    );
    results.extension.searchMs = Math.round(performance.now() - started);
    results.extension.dashboardHeapKb = await pageHeap(context, dashboard);
    await dashboard.close();
  } finally {
    cdp?.close();
    await context?.close().catch(() => {});
    desktop.kill();
    await discord.stop();
    await ws.cleanup();
  }
}

// --- Run ---

let dist = process.env.BENCH_DIST;
let built;
if (!dist) {
  built = await workspace("pbench-dist");
  dist = join(built.dir, "dist");
  await run("bun", ["run", "build.ts"], {
    cwd: browserDir,
    env: {
      ...process.env,
      PAROUSIA_ACTIVITIES_DIR: join(browserDir, "scripts", "activities", "fixtures", "parousia"),
      PAROUSIA_BUILD_DIR: dist,
    },
  });
}
try {
  if (await health()) throw new Error("something already answers on port 57179; stop it first");
  results.sizes = await sizes(dist);
  await benchDesktop();
  await benchExtension(dist);
} finally {
  await built?.cleanup();
}

const json = JSON.stringify(results, null, 2);
if (process.env.BENCH_OUT) await writeFile(process.env.BENCH_OUT, `${json}\n`);
console.log(json);
