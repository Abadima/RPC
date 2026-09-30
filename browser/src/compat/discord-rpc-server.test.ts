import { describe, expect, test } from "bun:test";
import type { Activity } from "../core/activity";
import { createPresence } from "../core/presence";
import { manualTimers } from "../core/test-desktop";
import {
  DISCORD_RPC_SERVER_URL,
  DiscordRpcServerLink,
  type DiscordLinkState,
  type ServerSocket,
} from "./discord-rpc-server";

/** A stand-in for the Discord-RPC-Extension app's WebSocket. */
class FakeSocket implements ServerSocket {
  sent: unknown[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.closed = true;
    this.onclose?.();
  }
  /** The app accepts the connection and says its version, as `server.js` does. */
  accept(version = "0.3.0"): void {
    this.onopen?.();
    this.onmessage?.({ data: JSON.stringify({ version }) });
  }
  refuse(): void {
    this.onclose?.();
  }
}

const jena: Activity = {
  id: "jena",
  name: "Jena",
  details: "Reading a page",
  state: "Documentation",
  url: "https://jena.systems",
  timestamps: { start: 1_700_000_000_000 },
};

function harness(clientId: string | null = "1234567890") {
  const timers = manualTimers();
  const sockets: FakeSocket[] = [];
  const link = new DiscordRpcServerLink({
    open: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    setTimer: timers.setTimer,
    clientIdFor: () => clientId,
    extId: "parousia-test",
  });
  const states: DiscordLinkState[] = [];
  link.onStateChange((state) => states.push(state));
  return { link, timers, sockets, states, last: () => sockets.at(-1) };
}

describe("DiscordRpcServerLink", () => {
  test("stays off until enabled, and connects to 127.0.0.1:6969 only when there's a reason", () => {
    const { link, sockets } = harness();
    link.send(createPresence(jena));
    expect(sockets).toHaveLength(0);
    expect(link.getState().status).toBe("off");

    link.setEnabled(true);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe(DISCORD_RPC_SERVER_URL);
    expect(DISCORD_RPC_SERVER_URL).toBe("ws://127.0.0.1:6969");
  });

  test("sets the activity with a client id and extId, and resends it before the app's 30 s timeout", () => {
    const { link, timers, last } = harness();
    link.setEnabled(true);
    link.send(createPresence(jena));
    last()?.accept();

    expect(link.getState()).toEqual({ status: "connected", version: "0.3.0" });
    expect(last()?.sent).toEqual([
      {
        clientId: "1234567890",
        extId: "parousia-test",
        presence: {
          name: "Jena",
          details: "Reading a page",
          state: "Documentation",
          startTimestamp: 1_700_000_000_000,
          instance: true,
        },
      },
    ]);
    timers.advance(15_000);
    expect(last()?.sent).toHaveLength(2);
  });

  test("clears only what it set, so it never wipes another tool's presence", () => {
    const { link, last } = harness();
    link.setEnabled(true);
    link.acquire();
    last()?.accept();
    link.send(createPresence(null));
    expect(last()?.sent).toEqual([]);

    link.send(createPresence(jena));
    link.send(createPresence(null));
    expect(last()?.sent.at(-1)).toEqual({ action: "disconnect" });
  });

  test("without a Discord client id there's nothing to show, so nothing is sent", () => {
    const { link, sockets } = harness(null);
    link.setEnabled(true);
    link.send(createPresence(jena));
    expect(sockets).toHaveLength(0);
  });

  test("ignores everything the app sends except its version (join requests, spectate, junk)", () => {
    const { link, last } = harness();
    link.setEnabled(true);
    link.acquire();
    last()?.accept("0.3.0");
    for (const data of [
      JSON.stringify({ action: "joinRequest", user: { id: "1" } }),
      JSON.stringify({ version: 7 }),
      JSON.stringify({ version: "x".repeat(100) }),
      "not json",
      new ArrayBuffer(8),
    ]) {
      last()?.onmessage?.({ data });
    }
    expect(link.getState()).toEqual({ status: "connected", version: "0.3.0" });
    expect(last()?.sent).toEqual([]);
  });

  test("not running: says so, and tries again every 10 seconds while needed", () => {
    const { link, timers, sockets } = harness();
    link.setEnabled(true);
    const release = link.acquire();
    sockets[0]?.refuse();
    expect(link.getState()).toEqual({ status: "unavailable", version: null });

    timers.advance(9999);
    expect(sockets).toHaveLength(1);
    timers.advance(1);
    expect(sockets).toHaveLength(2);

    release();
    sockets[1]?.refuse();
    timers.advance(60_000);
    expect(sockets).toHaveLength(2);
    expect(link.getState().status).toBe("idle");
  });

  test("lets go 30 seconds after nothing needs it, and disabling clears and closes at once", () => {
    const { link, timers, last } = harness();
    link.setEnabled(true);
    const release = link.acquire();
    last()?.accept();
    release();
    timers.advance(29_999);
    expect(last()?.closed).toBe(false);
    timers.advance(1);
    expect(last()?.closed).toBe(true);

    link.send(createPresence(jena));
    last()?.accept();
    link.setEnabled(false);
    expect(last()?.sent.at(-1)).toEqual({ action: "disconnect" });
    expect(last()?.closed).toBe(true);
    expect(link.getState()).toEqual({ status: "off", version: null });
    expect(timers.pending()).toBe(0);
  });

  test("yielding: no connecting or probing whatever wants it, and nothing left showing", () => {
    const { link, timers, sockets } = harness();
    link.setEnabled(true);
    link.setYielding(true);
    // A popup being open or an activity being there doesn't make it connect.
    const release = link.acquire();
    link.send(createPresence(jena));
    timers.advance(120_000);
    expect(sockets).toHaveLength(0);
    expect(link.getState()).toEqual({ status: "idle", version: null });
    release();
  });

  test("yielding while connected clears what it showed and closes at once, leaving no timers", () => {
    const { link, timers, last, sockets } = harness();
    link.setEnabled(true);
    link.send(createPresence(jena));
    last()?.accept();
    expect(last()?.sent).toHaveLength(1);

    link.setYielding(true);
    expect(last()?.sent.at(-1)).toEqual({ action: "disconnect" });
    expect(last()?.closed).toBe(true);
    expect(link.getState()).toEqual({ status: "idle", version: null });
    expect(timers.pending()).toBe(0);
    timers.advance(120_000);
    expect(sockets).toHaveLength(1);
  });

  test("yielding while retrying stops the retries", () => {
    const { link, timers, sockets } = harness();
    link.setEnabled(true);
    link.acquire();
    sockets[0]?.refuse();
    expect(timers.pending()).toBe(1);
    link.setYielding(true);
    expect(timers.pending()).toBe(0);
    timers.advance(60_000);
    expect(sockets).toHaveLength(1);
  });

  test("taking back shows the latest activity on one new connection, however often it flips", () => {
    const { link, sockets, last } = harness();
    link.setEnabled(true);
    link.setYielding(true);
    link.send(createPresence(jena));
    expect(sockets).toHaveLength(0);

    link.setYielding(false);
    link.setYielding(false);
    expect(sockets).toHaveLength(1);
    last()?.accept();
    expect(last()?.sent.at(-1)).toMatchObject({ presence: { name: "Jena" } });

    link.setYielding(true);
    link.setYielding(true);
    link.setYielding(false);
    expect(sockets).toHaveLength(2);
  });

  test("a yielding link that is enabled later, or disabled, stays quiet and consistent", () => {
    const { link, sockets } = harness();
    link.setYielding(true);
    link.setEnabled(true);
    link.send(createPresence(jena));
    expect(sockets).toHaveLength(0);
    link.setEnabled(false);
    link.setYielding(false);
    expect(sockets).toHaveLength(0);
    expect(link.getState().status).toBe("off");
  });
});
