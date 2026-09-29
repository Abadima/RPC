// A WebSocket client written by hand (handshake and framing), for what the
// end-to-end checks need that no browser will do: set any Origin header and
// send any bytes, the way a local process could.

import { randomBytes } from "node:crypto";
import { connect } from "node:net";

function clientFrame(payload, opcode = 1) {
  const mask = randomBytes(4);
  const length = payload.length;
  const header =
    length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | length])
      : length < 65536
        ? Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff])
        : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), bigLength(length)]);
  const masked = Buffer.from(payload);
  for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function bigLength(length) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(length));
  return buffer;
}

/**
 * Opens a WebSocket to `port` with whatever Origin header a local process
 * likes. Resolves with the HTTP status of the upgrade and, on 101, a way to
 * send text or raw bytes and read Desktop's replies.
 */
export function connectRaw({ port = 57179, origin, path = "/ws" }) {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const messages = [];
    const waiting = [];
    let closed = false;
    let head = "";
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    const deliver = (message) => {
      const waiter = waiting.shift();
      if (waiter) waiter(message);
      else messages.push(message);
    };
    socket.on("connect", () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        "Host: 127.0.0.1",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        "Sec-WebSocket-Version: 13",
      ];
      if (origin) lines.push(`Origin: ${origin}`);
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    });
    socket.on("data", (chunk) => {
      if (!upgraded) {
        head += chunk.toString("latin1");
        const end = head.indexOf("\r\n\r\n");
        if (end === -1) return;
        const status = Number(head.split(" ")[1]);
        if (status !== 101) {
          socket.destroy();
          resolve({ status });
          return;
        }
        upgraded = true;
        buffer = Buffer.from(head.slice(end + 4), "latin1");
        resolve({
          status,
          sendText: (text) => socket.write(clientFrame(Buffer.from(text))),
          sendBytes: (bytes) => socket.write(bytes),
          frame: clientFrame,
          next: (timeoutMs = 5000) =>
            messages.length
              ? Promise.resolve(messages.shift())
              : closed
                ? Promise.resolve(null)
                : new Promise((done) => {
                    waiting.push(done);
                    setTimeout(() => done(undefined), timeoutMs);
                  }),
          isClosed: () => closed,
          close: () => socket.destroy(),
        });
      } else {
        buffer = Buffer.concat([buffer, chunk]);
      }
      // Server frames are unmasked.
      while (buffer.length >= 2) {
        const opcode = buffer[0] & 0x0f;
        let length = buffer[1] & 0x7f;
        let at = 2;
        if (length === 126) {
          if (buffer.length < 4) break;
          length = buffer.readUInt16BE(2);
          at = 4;
        }
        if (buffer.length < at + length) break;
        const payload = buffer.subarray(at, at + length);
        buffer = buffer.subarray(at + length);
        if (opcode === 1) deliver(JSON.parse(payload.toString()));
        if (opcode === 8) deliver(null);
      }
    });
    socket.on("close", () => {
      closed = true;
      while (waiting.length) waiting.shift()(null);
    });
    socket.on("error", (error) => (upgraded ? undefined : reject(error)));
  });
}
