import { describe, expect, test } from "bun:test";
import type { ChannelOpener } from "./channel";
import { DesktopConnection, type ConnectionState } from "./desktop-connection";
import { PROTOCOL_VERSION } from "./desktop-protocol";
import { createPresence } from "./presence";
import {
  FakeDesktop,
  REPORT,
  fakeChannel,
  manualTimers,
  settle,
  type ManualTimers,
} from "./test-desktop";

const activity = { id: "a", name: "A", url: "https://a.example" };

function harness(channel: ChannelOpener): {
  connection: DesktopConnection;
  timers: ManualTimers;
  states: ConnectionState[];
} {
  const timers = manualTimers();
  const connection = new DesktopConnection({
    channel,
    clientName: "Test Browser",
    setTimer: timers.setTimer,
  });
  const states: ConnectionState[] = [];
  connection.onStateChange((state) => states.push(state));
  return { connection, timers, states };
}

describe("DesktopConnection demand", () => {
  test("does nothing until something needs Desktop", async () => {
    const ws = fakeChannel(new FakeDesktop());
    const { connection, timers } = harness(ws);
    connection.send(createPresence(null));
    await settle();
    expect(ws.opened).toHaveLength(0);
    expect(timers.pending()).toBe(0);
    expect(connection.getState().status).toBe("idle");
  });

  test("an Activity connects, says hello, and sends the Presence after the welcome", async () => {
    const desktop = new FakeDesktop();
    const { connection, states } = harness(fakeChannel(desktop));
    const presence = createPresence(activity);
    connection.send(presence);
    await settle();

    expect(connection.getState()).toEqual({ status: "connected" });
    expect(states.map((s) => s.status)).toEqual(["connecting", "connected"]);
    expect(desktop.received[0]).toEqual({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      name: "Test Browser",
    });
    expect(desktop.presences()).toEqual([JSON.parse(JSON.stringify(presence))]);
  });

  test("an unneeded connection lingers, then closes to idle with no timers left", async () => {
    const desktop = new FakeDesktop();
    const ws = fakeChannel(desktop);
    const { connection, timers } = harness(ws);
    connection.send(createPresence(activity));
    await settle();
    connection.send(createPresence(null));
    expect(desktop.presences().at(-1)).toMatchObject({ activity: null });
    expect(ws.opened[0]?.closedByClient).toBe(false);

    timers.advance(30_000);
    expect(ws.opened[0]?.closedByClient).toBe(true);
    expect(connection.getState().status).toBe("idle");
    expect(timers.pending()).toBe(0);
  });

  test("an open UI holds the connection and releasing it lets go", async () => {
    const { connection, timers } = harness(fakeChannel(new FakeDesktop()));
    const release = connection.acquire();
    await settle();
    expect(connection.getState().status).toBe("connected");
    release();
    release();
    timers.advance(30_000);
    expect(connection.getState().status).toBe("idle");
  });

  test("sends nothing but what's needed: no pings, and no timers while connected", async () => {
    const desktop = new FakeDesktop();
    const { connection, timers } = harness(fakeChannel(desktop));
    connection.send(createPresence(activity));
    await settle();
    expect(timers.pending()).toBe(0);
    timers.advance(10 * 60_000);
    expect(desktop.received.map((m) => m.type)).toEqual(["hello", "presence"]);
  });
});

describe("DesktopConnection failures", () => {
  test("a silent server times out after 5 seconds and is retried later", async () => {
    const ws = fakeChannel(new FakeDesktop(), "silent");
    const { connection, timers } = harness(ws);
    connection.send(createPresence(activity));
    await settle();
    expect(connection.getState().status).toBe("connecting");
    timers.advance(5000);
    expect(ws.opened[0]?.closedByClient).toBe(true);
    expect(connection.getState().status).toBe("disconnected");

    ws.behavior = "normal";
    timers.advance(10_000);
    await settle();
    expect(connection.getState().status).toBe("connected");
  });

  test("something that isn't Desktop on the port is treated like nothing there", async () => {
    const ws = fakeChannel(new FakeDesktop(), "garbage");
    const { connection, timers } = harness(ws);
    connection.send(createPresence(activity));
    await settle();
    expect(ws.opened[0]?.closedByClient).toBe(true);
    expect(connection.getState().status).toBe("disconnected");
    expect(timers.pending()).toBe(1);
  });

  test("a reject other than a refusal (a timeout, say) is retried", async () => {
    const desktop = new FakeDesktop();
    desktop.rejectHello = "timeout";
    const { connection, timers } = harness(fakeChannel(desktop));
    connection.send(createPresence(activity));
    await settle();
    expect(connection.getState().status).toBe("disconnected");
    desktop.rejectHello = null;
    timers.advance(10_000);
    await settle();
    expect(connection.getState().status).toBe("connected");
  });
});

describe("DesktopConnection refusals and reconnecting", () => {
  test("not allowed: stops retrying until a UI opens, then checks again", async () => {
    const desktop = new FakeDesktop();
    desktop.rejectHello = "origin_not_allowed";
    const ws = fakeChannel(desktop);
    const { connection, timers } = harness(ws);
    connection.send(createPresence(activity));
    await settle();
    expect(connection.getState().status).toBe("not_allowed");
    timers.advance(120_000);
    expect(ws.opened).toHaveLength(1);

    desktop.rejectHello = null;
    connection.acquire();
    await settle();
    expect(connection.getState().status).toBe("connected");
  });

  test("another protocol version is reported as incompatible", async () => {
    const desktop = new FakeDesktop();
    desktop.rejectHello = "unsupported_version";
    const { connection } = harness(fakeChannel(desktop));
    connection.acquire();
    await settle();
    expect(connection.getState().status).toBe("incompatible");
  });

  test("a welcome for another protocol version isn't accepted", async () => {
    const desktop = new FakeDesktop();
    desktop.protocolVersion = PROTOCOL_VERSION - 1;
    const { connection } = harness(fakeChannel(desktop));
    connection.acquire();
    await settle();
    expect(connection.getState().status).toBe("disconnected");
  });

  test("with Desktop absent it retries every 10 seconds, and picks it up once it starts", async () => {
    const desktop = new FakeDesktop();
    const ws = fakeChannel(desktop, "absent");
    const { connection, timers } = harness(ws);
    connection.send(createPresence(activity));
    await settle();
    expect(connection.getState().status).toBe("disconnected");

    for (let attempt = 0; attempt < 4; attempt++) {
      const before = ws.opened.length;
      timers.advance(9999);
      await settle();
      expect(ws.opened).toHaveLength(before);
      timers.advance(1);
      await settle();
      expect(ws.opened).toHaveLength(before + 1);
    }

    ws.behavior = "normal";
    timers.advance(10_000);
    await settle();
    expect(connection.getState()).toEqual({ status: "connected" });
    expect(desktop.presences()).toHaveLength(1);
  });

  test("reconnect() skips the wait, and a working connection ignores it", async () => {
    const ws = fakeChannel(new FakeDesktop(), "absent");
    const { connection, timers } = harness(ws);
    connection.acquire();
    await settle();
    timers.advance(10_000);
    await settle();
    expect(ws.opened).toHaveLength(2);
    expect(connection.getState().status).toBe("disconnected");

    ws.behavior = "normal";
    connection.reconnect();
    await settle();
    expect(ws.opened).toHaveLength(3);
    expect(connection.getState()).toEqual({ status: "connected" });
    expect(timers.pending()).toBe(0);

    connection.reconnect();
    await settle();
    expect(ws.opened).toHaveLength(3);
  });

  test("reconnect() checks again after a refusal", async () => {
    const desktop = new FakeDesktop();
    desktop.rejectHello = "origin_not_allowed";
    const { connection } = harness(fakeChannel(desktop));
    connection.acquire();
    await settle();
    expect(connection.getState().status).toBe("not_allowed");

    desktop.rejectHello = null;
    connection.reconnect();
    await settle();
    expect(connection.getState().status).toBe("connected");
  });

  test("losing all demand cancels a pending retry", async () => {
    const { connection, timers } = harness(fakeChannel(new FakeDesktop(), "absent"));
    connection.send(createPresence(activity));
    await settle();
    connection.send(createPresence(null));
    expect(timers.pending()).toBe(0);
    expect(connection.getState().status).toBe("idle");
  });

  test("a dropped connection reconnects and resends the current Presence", async () => {
    const desktop = new FakeDesktop();
    const ws = fakeChannel(desktop);
    const { connection, timers } = harness(ws);
    connection.send(createPresence(activity));
    await settle();
    ws.opened[0]?.end();
    expect(connection.getState().status).toBe("disconnected");
    timers.advance(10_000);
    await settle();
    expect(desktop.presences()).toHaveLength(2);
  });

  test("pause() lets go at once and resume() picks back up", async () => {
    const ws = fakeChannel(new FakeDesktop());
    const { connection, timers } = harness(ws);
    connection.send(createPresence(activity));
    await settle();
    connection.pause();
    expect(ws.opened[0]?.closedByClient).toBe(true);
    expect(connection.getState().status).toBe("idle");
    connection.acquire();
    await settle();
    expect(ws.opened).toHaveLength(1);
    expect(timers.pending()).toBe(0);

    connection.resume();
    await settle();
    expect(connection.getState().status).toBe("connected");
  });
});

describe("DesktopConnection requests", () => {
  test("status and settings requests resolve with Desktop's report", async () => {
    const desktop = new FakeDesktop();
    const { connection } = harness(fakeChannel(desktop));
    expect(await connection.requestStatus()).toBeNull();
    connection.acquire();
    await settle();
    expect(await connection.requestStatus()).toEqual(REPORT);
    const changed = await connection.setSetting("allowUserscripts", true);
    expect(changed?.settings.allowUserscripts).toBe(true);
    desktop.refuseSettings = true;
    expect(await connection.setSetting("allowUserscripts", false)).toBeNull();
  });

  test("pending requests resolve to null when the connection ends", async () => {
    const ws = fakeChannel(new FakeDesktop());
    const { connection } = harness(ws);
    connection.acquire();
    await settle();
    ws.behavior = "silent";
    const pending = connection.requestStatus();
    connection.close();
    expect(await pending).toBeNull();
  });
});
