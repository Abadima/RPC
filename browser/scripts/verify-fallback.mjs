// Checks that Discord-RPC-Extension's app (port 6969) is only a fallback for
// Parousia Desktop (port 57179): with a real extension build in Chromium, a
// real Desktop, and a stand-in for the app that counts every connection:
//
// 1. While Desktop is connected and healthy, with a dashboard open (which
//    keeps the extension's links up) and something to show, the app is never
//    contacted: no connection, no probe.
// 2. Desktop stops: the app takes over within one retry, and shows the same
//    presence.
// 3. Desktop comes back: the app's presence is cleared and the connection
//    closed, Desktop shows it again, and nothing contacts the app afterwards.
//
// It runs in a private network namespace (`unshare -rn`, with its own
// loopback), so ports 57179 and 6969 are free whatever is running here, and a
// real discord_rpc_ext with someone's live Discord status is never touched.
//
// Prerequisites: `bun run build`, `cargo build` in ../desktop. Linux only.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { chromium } from "playwright-core";
import { join } from "node:path";
import { startFakeDiscord } from "./e2e/fake-discord.mjs";
import {
  PAROUSIA_CLIENT_ID,
  STEP_TIMEOUT_MS,
  assert,
  browserDir,
  control,
  status,
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

const log = logger("fallback");
const extensionDir = join(browserDir, "dist", "chromium");
const RETRY_MS = 10_000;

/** A stand-in for the app: a WebSocket server on 6969 that says its version and records everything. */
function startApp() {
  const connections = [];
  const messages = [];
  const server = createServer((socket) => {
    const record = { closed: false };
    connections.push(record);
    socket.on("error", () => {});
    socket.on("close", () => (record.closed = true));
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end === -1) return;
        const key = /sec-websocket-key: (.+)\r\n/i.exec(buffer.subarray(0, end).toString())?.[1];
        buffer = buffer.subarray(end + 4);
        if (!key) return socket.destroy();
        const accept = createHash("sha1")
          .update(`${key.trim()}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        socket.write(
          `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        const hello = Buffer.from(JSON.stringify({ version: "0.3.0" }));
        socket.write(Buffer.concat([Buffer.from([0x81, hello.length]), hello]));
        upgraded = true;
      }
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        if (buffer.length < offset + 4 + length) return;
        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buffer = buffer.subarray(offset + 4 + length);
        if (opcode === 1) messages.push(JSON.parse(payload.toString()));
        if (opcode === 8) {
          // A close handshake, as a real WebSocket server finishes one.
          record.closed = true;
          socket.end(Buffer.from([0x88, 0]));
        }
      }
    });
  });
  return new Promise((resolve) =>
    server.listen(6969, "127.0.0.1", () =>
      resolve({ connections, messages, close: () => server.close() }),
    ),
  );
}

const ws = await workspace("pfb");
const discord = await startFakeDiscord(ws.discordDir);
const app = await startApp();
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
  const extension = `chrome-extension://${new URL(worker.url()).host}`;
  await control(ws, "allow", extension);
  // Something to show everywhere, from the Default Activity.
  await worker.evaluate(() =>
    chrome.storage.local.set({
      defaultActivity: {
        enabled: true,
        name: "Fallback check",
        details: "Nothing else is running",
        state: "",
        largeImage: "",
        largeText: "",
        smallImage: "",
        smallText: "",
        buttons: [],
        elapsed: false,
        discordClientId: "",
      },
    }),
  );
  const page = await context.newPage();
  await page.route("https://nothing.example/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Nothing</title>" }),
  );
  await page.goto("https://nothing.example/");
  // A dashboard open keeps every link up, which is what used to make the app get probed.
  const dashboard = await context.newPage();
  await dashboard.goto(`${extension}/fullscreen.html#settings/platforms`);
  await page.bringToFront();

  // --- 1. Desktop healthy: the app is left alone ---
  // Until this build was allowed, Desktop refused it, which counts as not answering: the
  // app may have been tried meanwhile. What matters is what happens once Desktop answers.
  await waitUntil(
    async () => (await status(ws)).clients.length > 0,
    "Desktop to have the extension connected",
  );
  await discord.waitFor(
    (a) => a?.details === "Nothing else is running",
    "the Default Activity via Desktop",
  );
  await sleep(3000);
  assert(
    app.connections.every((connection) => connection.closed),
    `whatever the app was given before Desktop answered is let go of (${JSON.stringify(app.connections)}, ${app.messages.length} messages)`,
  );
  const settled = app.connections.length;
  const settledMessages = app.messages.length;
  log("Desktop shows the presence; watching the app for two retry periods");
  await sleep(2.5 * RETRY_MS);
  assert(
    app.connections.length === settled && app.messages.length === settledMessages,
    `the app was contacted again (${settled} -> ${app.connections.length} connections) while Desktop was connected`,
  );
  log(
    "1. Desktop connected and healthy: the app got no connection and no probe, with a dashboard open",
  );

  // --- 2. Desktop stops: the app takes over ---
  await desktop.stop();
  await waitUntil(
    () => app.messages.some((m) => m.presence?.details === "Nothing else is running"),
    "the app to show the presence once Desktop was gone",
    2 * RETRY_MS + STEP_TIMEOUT_MS,
  );
  const first = app.messages.find((m) => m.presence);
  assert(first.clientId === PAROUSIA_CLIENT_ID, `as Parousia's Application (${first.clientId})`);
  assert(
    app.connections.length === settled + 1,
    `over one new connection (${settled} -> ${app.connections.length})`,
  );
  log("2. Desktop gone: the app took over with one connection and the same presence");

  // --- 3. Desktop returns: the app lets go ---
  const before = app.messages.length;
  discord.activities.length = 0;
  desktop = startDesktop(ws);
  await desktop.waitFor(/listening on 127\.0\.0\.1:57179/);
  await waitUntil(
    () =>
      app.messages.slice(before).some((m) => m.action === "disconnect") &&
      app.connections.at(-1)?.closed,
    "the app's presence to be cleared and its connection closed once Desktop was back",
    2 * RETRY_MS + STEP_TIMEOUT_MS,
  );
  await discord.waitFor(
    (a) => a?.details === "Nothing else is running",
    "the presence via Desktop again",
  );
  const count = app.connections.length;
  const sent = app.messages.length;
  await sleep(2.5 * RETRY_MS);
  assert(
    app.connections.length === count,
    `no new connection to the app (${count} -> ${app.connections.length})`,
  );
  assert(app.messages.length === sent, "and nothing sent to it");
  log(
    "3. Desktop back: the app's presence cleared and its connection closed; Desktop shows it, and the app is left alone again",
  );
  log("done");
} finally {
  await context?.close().catch(() => {});
  await desktop?.stop();
  await discord.stop();
  app.close();
  await ws.cleanup();
}
