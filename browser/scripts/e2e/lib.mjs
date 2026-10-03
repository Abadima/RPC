// Shared pieces of the real-process end-to-end checks: a Parousia Desktop
// build running against a throwaway data and runtime directory (so a real
// config or socket is never touched), its CLI, and helpers
// for driving the extension's popup page.
//
// Linux and Windows. Desktop's directories are redirected with XDG_DATA_HOME
// and XDG_RUNTIME_DIR on Linux, and PAROUSIA_DATA_DIR on Windows (whose own
// can't be moved by an environment variable); its Discord is the fake one's
// directory on Linux, and the fake one's named pipe on Windows. Port 57179
// must be free.

import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

export const browserDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const windows = process.platform === "win32";
export const desktopBinary =
  process.env.PAROUSIA_DESKTOP_BIN ??
  join(browserDir, "..", "desktop", "target", "debug", `Parousia-Desktop${windows ? ".exe" : ""}`);
export const STEP_TIMEOUT_MS = 20_000;

const run = promisify(execFile);

/**
 * Every process the checks start, so they're stopped even if a check crashes
 * before its `finally` runs: a leftover browser or Desktop would hold the
 * port (and a tray icon) after the run.
 */
const children = new Set();
export function track(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}
for (const event of ["exit", "SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"]) {
  process.on(event, (error) => {
    for (const child of children) child.kill();
    if (event === "exit") return;
    if (error instanceof Error) console.error(error);
    process.exit(1);
  });
}

export function logger(tag) {
  let step = 0;
  return (message) => console.log(`[${tag}] ${String(++step).padStart(2)}. ${message}`);
}

export function assert(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` (which returns a truthy value when done) until it passes. Test-side only. */
export async function waitUntil(check, description, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(150);
  }
  throw new Error(
    `timed out waiting for ${description} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`,
  );
}

/**
 * A throwaway place for Desktop's files. The runtime directory holds the
 * IPC socket and must be private, like a real XDG_RUNTIME_DIR.
 *
 * Desktop looks for Discord only in `discordDir`, empty unless a check puts
 * a fake Discord there (fake-discord.mjs), so a test run never shows
 * anything on a real Discord. Only `discord:verify` passes a real one. On
 * Windows `discordDir` is a named pipe's name up to its number
 * (`\.\pipe\...-discord-ipc-`) rather than a directory.
 */
export async function workspace(prefix, { discordDir } = {}) {
  // Short, so socket paths stay under the 108-byte limit.
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const dataHome = join(dir, "data");
  const runtimeDir = join(dir, "run");
  const ownDiscordDir = join(dir, "discord");
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(ownDiscordDir, { mode: 0o700 });
  if (!windows) await chmod(runtimeDir, 0o700);
  const discord =
    discordDir ?? (windows ? `\\\\.\\pipe\\${basename(dir)}-discord-ipc-` : ownDiscordDir);
  return {
    dir,
    dataHome,
    runtimeDir,
    discordDir: discord,
    configDir: join(dataHome, "parousia"),
    env: {
      ...process.env,
      ...(windows
        ? { PAROUSIA_DATA_DIR: join(dataHome, "parousia"), PAROUSIA_DISCORD_IPC_PIPE: discord }
        : {
            XDG_DATA_HOME: dataHome,
            XDG_RUNTIME_DIR: runtimeDir,
            PAROUSIA_DISCORD_IPC_DIR: discord,
          }),
    },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * `tray: true` runs the tray on the real session bus (it shows up in the
 * panel). Always in debug mode: these checks read Desktop's log, which is
 * silent otherwise.
 */
export function startDesktop(ws, { tray = false } = {}) {
  const child = track(
    spawn(desktopBinary, tray ? ["--debug"] : ["--headless", "--debug"], {
      env: ws.env,
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  const lines = [];
  const waiters = [];
  const onData = (chunk) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      lines.push(line);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pattern.test(line)) waiters.splice(i, 1)[0].resolve(line);
      }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  return {
    pid: child.pid,
    trayName: `org.kde.StatusNotifierItem-${child.pid}-1`,
    lines,
    /** Position to pass to `waitFor`, taken before triggering what should log. */
    mark: () => lines.length,
    /** Resolves with the first line matching `pattern` logged at or after `since`. */
    waitFor(pattern, since = 0, timeoutMs = STEP_TIMEOUT_MS) {
      const past = lines.slice(since).find((line) => pattern.test(line));
      if (past) return Promise.resolve(past);
      return new Promise((resolve, reject) => {
        const waiter = { pattern, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index === -1) return;
          waiters.splice(index, 1);
          reject(new Error(`timed out waiting for Desktop to log ${pattern}\n${lines.join("\n")}`));
        }, timeoutMs);
      });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill();
      await exited;
    },
  };
}

/** Runs a Desktop command and returns its text output. */
export async function command(ws, ...args) {
  const { stdout } = await run(desktopBinary, args, { env: ws.env });
  return stdout;
}

export async function cli(ws, ...args) {
  const { stdout } = await run(desktopBinary, [...args, "--json"], { env: ws.env });
  return JSON.parse(stdout);
}

/** Desktop's status report (`Parousia-Desktop status --json`). */
export async function status(ws) {
  const response = await cli(ws, "status");
  assert(response.result === "status", `status returned ${JSON.stringify(response)}`);
  return response.status;
}

/** Runs a control command that answers with the new status, and returns it. */
export async function control(ws, ...args) {
  const response = await cli(ws, ...args);
  assert(response.result === "status", `${args.join(" ")} returned ${JSON.stringify(response)}`);
  return response.status;
}

/**
 * Turns off the extension's link to Discord-RPC-Extension's app, evaluated
 * in the extension before any popup opens. A real app may be listening on
 * port 6969 with someone's live Discord status; test browsers stay away.
 */
export const QUIET_DISCORD = `chrome.storage.local.set({ preferences: { discordRpcExtension: false } })`;

/** Turns the extension's Settings > Platforms > Discord on or off, evaluated in the extension. */
export const setDiscordPlatform = (on) => `(async () => {
  const { preferences = {} } = await chrome.storage.local.get("preferences");
  const platforms = { discord: true, fluxer: true, stoat: true, ...preferences.platforms, discord: ${on} };
  await chrome.storage.local.set({ preferences: { ...preferences, platforms } });
})()`;

/** Parousia's own Discord Application, which Desktop shows Activities as by default. */
export const PAROUSIA_CLIENT_ID = "1553980756731363428";

/** The footer's status, without Desktop's version. */
export const STATUS_LINE = `(() => {
  const label = document.getElementById("status-label");
  return label ? label.textContent.replace(/ v\\S+$/, "") : null;
})()`;

/** Popup helpers for any Playwright page showing `popup.html`. */
export const popup = {
  status: (page) => page.evaluate(STATUS_LINE),

  async waitForStatus(page, pattern, timeoutMs = STEP_TIMEOUT_MS) {
    return waitUntil(
      async () => {
        const text = await popup.status(page);
        return pattern.test(text ?? "") ? text : false;
      },
      `popup status ${pattern}`,
      timeoutMs,
    );
  },

  /** The popup's "what to do about it" line, or null while it's hidden. */
  async help(page) {
    const hidden = await page.$eval("#connection-help", (el) => el.hidden);
    return hidden ? null : page.textContent("#connection-help");
  },
};

/** An Activity's packaged manifest, from its shard (src/activities/manifest.ts, `manifestShard`), or `null`. */
export async function readManifest(extensionDir, id) {
  const name = id.startsWith("premid:") ? id.slice("premid:".length) : id;
  const first = name.normalize("NFKD").charAt(0).toLowerCase();
  const shard = /^[a-z0-9]$/.test(first) ? first : "_";
  const shards = JSON.parse(
    await readFile(join(extensionDir, "activities", "manifests", `${shard}.json`), "utf8"),
  );
  return shards[id] ?? null;
}
