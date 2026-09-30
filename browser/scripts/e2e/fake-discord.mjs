// A stand-in for the Discord app's local RPC socket, for the end-to-end
// checks: Parousia Desktop is pointed at it (PAROUSIA_DISCORD_IPC_DIR), so a
// test run never shows anything on someone's real Discord. It speaks
// Discord's framing (an 8-byte header: opcode and length, little-endian,
// then JSON), answers the handshake with READY and every SET_ACTIVITY with
// success, and records what it's sent.

import { createServer } from "node:net";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { waitUntil } from "./lib.mjs";

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;

function frame(op, body) {
  const json = Buffer.from(JSON.stringify(body));
  const header = Buffer.alloc(8);
  header.writeUInt32LE(op, 0);
  header.writeUInt32LE(json.length, 4);
  return Buffer.concat([header, json]);
}

export async function startFakeDiscord(dir) {
  const path = join(dir, "discord-ipc-0");
  await rm(path, { force: true });
  const handshakes = [];
  /** Every SET_ACTIVITY's activity, in order: `null` clears. */
  const activities = [];
  const sockets = new Set();

  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 8) {
        const op = buffer.readUInt32LE(0);
        const length = buffer.readUInt32LE(4);
        if (buffer.length < 8 + length) return;
        const body = JSON.parse(buffer.subarray(8, 8 + length).toString());
        buffer = buffer.subarray(8 + length);
        if (op === OP_HANDSHAKE) {
          handshakes.push(body.client_id);
          socket.write(frame(OP_FRAME, { cmd: "DISPATCH", evt: "READY", data: { v: 1 } }));
        } else if (op === OP_FRAME && body.cmd === "SET_ACTIVITY") {
          activities.push(body.args?.activity ?? null);
          socket.write(
            frame(OP_FRAME, {
              cmd: "SET_ACTIVITY",
              evt: null,
              nonce: body.nonce,
              data: body.args?.activity ?? null,
            }),
          );
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(path, resolve));

  return {
    handshakes,
    activities,
    /** Waits until what's shown passes `check`, and returns it. */
    waitFor(check, description, timeoutMs = 30_000) {
      return waitUntil(
        () =>
          activities.length > 0 && check(activities.at(-1)) ? (activities.at(-1) ?? true) : false,
        `Discord to show ${description} (sent so far: ${JSON.stringify(activities)})`,
        timeoutMs,
      );
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
