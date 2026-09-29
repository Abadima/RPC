import { describe, expect, test } from "bun:test";
import { webSocketChannel, type WebSocketLike } from "./channel";

class FakeSocket implements WebSocketLike {
  readyState = 1;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
}

function recorder(): {
  messages: unknown[];
  closes: number;
  opens: number;
  handlers: { onOpen(): void; onMessage(m: unknown): void; onClose(): void };
} {
  const result = {
    messages: [] as unknown[],
    closes: 0,
    opens: 0,
    handlers: {
      onOpen: () => {
        result.opens++;
      },
      onMessage: (message: unknown) => result.messages.push(message),
      onClose: () => {
        result.closes++;
      },
    },
  };
  return result;
}

describe("webSocketChannel", () => {
  test("parses messages, serializes sends, and targets the fixed loopback port", () => {
    let url = "";
    const socket = new FakeSocket();
    const opener = webSocketChannel(undefined, (u) => {
      url = u;
      return socket;
    });
    const { messages, handlers } = recorder();
    const channel = opener.open(handlers);

    socket.onmessage?.({ data: '{"type":"pong"}' });
    socket.onmessage?.({ data: "{not json" });
    channel.send({ type: "ping" });

    expect(url).toBe("ws://127.0.0.1:57179/ws");
    expect(messages).toEqual([{ type: "pong" }]);
    expect(socket.sent).toEqual(['{"type":"ping"}']);
  });

  test("an error followed by a close is reported once; our own close() isn't reported", () => {
    const socket = new FakeSocket();
    const rec = recorder();
    webSocketChannel(undefined, () => socket).open(rec.handlers);
    const onclose = socket.onclose;
    socket.onerror?.();
    onclose?.();
    expect(rec.closes).toBe(1);

    const other = new FakeSocket();
    const second = recorder();
    const channel = webSocketChannel(undefined, () => other).open(second.handlers);
    channel.close();
    other.onclose?.();
    expect(other.closed).toBe(true);
    expect(second.closes).toBe(0);
  });

  test("oversized or binary messages end the channel", () => {
    for (const data of ["x".repeat(16 * 1024 + 1), new ArrayBuffer(4)]) {
      const socket = new FakeSocket();
      const rec = recorder();
      webSocketChannel(undefined, () => socket).open(rec.handlers);
      socket.onmessage?.({ data });
      expect(rec.messages).toHaveLength(0);
      expect(rec.closes).toBe(1);
      expect(socket.closed).toBe(true);
    }
  });

  test("reports when the socket opens", () => {
    const socket = new FakeSocket();
    const rec = recorder();
    webSocketChannel(undefined, () => socket).open(rec.handlers);
    expect(rec.opens).toBe(0);
    socket.onopen?.();
    expect(rec.opens).toBe(1);
  });

  test("a socket that can't even be constructed reports a close", async () => {
    const rec = recorder();
    webSocketChannel(undefined, () => {
      throw new Error("blocked");
    }).open(rec.handlers);
    await Promise.resolve();
    expect(rec.closes).toBe(1);
  });

  test("sends are dropped while the socket isn't open yet", () => {
    const socket = new FakeSocket();
    socket.readyState = 0;
    webSocketChannel(undefined, () => socket)
      .open(recorder().handlers)
      .send({ type: "ping" });
    expect(socket.sent).toHaveLength(0);
  });
});
