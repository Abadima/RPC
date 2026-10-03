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

function harness(
  channel: ChannelOpener,
  version = "1.0.0",
): {
  connection: DesktopConnection;
  timers: ManualTimers;
  states: ConnectionState[];
} {
  const timers = manualTimers();
  const connection = new DesktopConnection({
    channel,
    clientName: "Test Browser",
    version,
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

    expect(connection.getState()).toEqual({ status: "connected", desktopVersion: "1.0.0" });
    expect(states.map((s) => s.status)).toEqual(["connecting", "connected"]);
    expect(desktop.received[0]).toEqual({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      version: "1.0.0",
      name: "Test Browser",
    });
    // The page's address stays in the browser: Desktop gets only what it shows.
    expect(desktop.presences()).toEqual([
      { activity: { id: "a", name: "A" }, updatedAt: presence.updatedAt },
    ]);
  });

  test("only the fields Desktop takes leave the browser, whatever else an Activity carries", async () => {
    const desktop = new FakeDesktop();
    const { connection } = harness(fakeChannel(desktop));
    const full = {
      ...activity,
      details: "Details",
      state: "State",
      detailsUrl: "https://a.example/d",
      stateUrl: "https://a.example/s",
      assets: { largeImage: "https://a.example/l.png", largeText: "L" },
      timestamps: { start: 1 },
      buttons: [{ label: "Open", url: "https://a.example/" }],
      discordClientId: "1553980756731363428",
    };
    const extra = {
      ...full,
      secret: "session=abc",
      buttons: [{ label: "Open", url: "https://a.example/", x: 1 }],
    };
    connection.send(createPresence(extra));
    await settle();
    const { url: _url, ...expected } = full;
    expect(desktop.presences()).toEqual([{ activity: expected, updatedAt: expect.any(Number) }]);
  });

  test("each Presence says where it may be shown, and a new choice resends it", async () => {
    const desktop = new FakeDesktop();
    const ws = fakeChannel(desktop);
    const { connection, timers } = harness(ws);
    connection.setPlatforms(["discord", "stoat"]);
    connection.send(createPresence(activity));
    await settle();
    const platforms = (): unknown[] =>
      desktop.received.filter((m) => m.type === "presence").map((m) => m.platforms);
    expect(platforms()).toEqual([["discord", "stoat"]]);

    connection.setPlatforms(["discord", "stoat"]);
    expect(platforms()).toHaveLength(1);
    connection.setPlatforms(["stoat"]);
    expect(platforms()).toEqual([["discord", "stoat"], ["stoat"]]);

    // And after Desktop comes back.
    ws.opened[0]?.end();
    timers.advance(10_000);
    await settle();
    expect(platforms().at(-1)).toEqual(["stoat"]);
  });

  test("without a choice, Presence goes without platforms (Desktop: everywhere)", async () => {
    const desktop = new FakeDesktop();
    const { connection } = harness(fakeChannel(desktop));
    connection.send(createPresence(activity));
    await settle();
    expect(desktop.received.find((m) => m.type === "presence")).not.toHaveProperty("platforms");
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

  test("a welcome for another protocol version or major isn't accepted", async () => {
    for (const change of [
      (desktop: FakeDesktop) => (desktop.protocolVersion = PROTOCOL_VERSION - 1),
      (desktop: FakeDesktop) => (desktop.version = "2.0.0"),
      (desktop: FakeDesktop) => (desktop.version = "0.9.0"),
      (desktop: FakeDesktop) => (desktop.version = "not a version"),
    ]) {
      const desktop = new FakeDesktop();
      change(desktop);
      const ws = fakeChannel(desktop);
      const { connection, timers } = harness(ws);
      connection.send(createPresence(activity));
      await settle();
      expect(connection.getState()).toEqual({ status: "incompatible" });
      timers.advance(120_000);
      expect(ws.opened).toHaveLength(1);
    }
  });

  test("another minor, patch, or beta stays connected and says which side to update", async () => {
    for (const [desktopVersion, update] of [
      ["1.2.0", undefined],
      ["1.2.0-beta.4", undefined],
      ["1.1.9", "desktop"],
      ["1.0.0-beta.1", "desktop"],
      ["1.3.0", "extension"],
      ["1.2.1", "extension"],
    ] as const) {
      const desktop = new FakeDesktop();
      desktop.version = desktopVersion;
      const { connection } = harness(fakeChannel(desktop), "1.2.0");
      connection.send(createPresence(activity));
      await settle();
      expect(connection.getState()).toEqual({
        status: "connected",
        desktopVersion,
        ...(update && { update }),
      });
      expect(desktop.presences()).toHaveLength(1);
    }
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
    expect(connection.getState()).toMatchObject({ status: "connected" });
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
    expect(connection.getState()).toMatchObject({ status: "connected" });
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
