import { describe, expect, test } from "bun:test";
import { UI_PORT_NAME } from "../core/ui-port";
import type { AdapterState, DesktopReport } from "../core/desktop-protocol";
import { REPORT } from "../core/test-desktop";
import {
  connectToBackground,
  connectionBadge,
  connectionHelp,
  connectionStatusLabel,
  desktopPlatformLabel,
  discordBridgeLabel,
  showsDiscordBridge,
  displayedState,
  isOffline,
} from "./connection-status";

function installChromeMock(): {
  names: string[];
  posted: unknown[];
  deliver: (message: unknown) => void;
} {
  const names: string[] = [];
  const posted: unknown[] = [];
  const listeners: Array<(message: unknown) => void> = [];
  globalThis.chrome = {
    runtime: {
      connect: ({ name }: { name: string }) => {
        names.push(name);
        return {
          postMessage: (message: unknown) => posted.push(message),
          onMessage: { addListener: (l: (message: unknown) => void) => listeners.push(l) },
        };
      },
    },
  } as unknown as typeof chrome;
  return { names, posted, deliver: (message) => listeners.forEach((l) => l(message)) };
}

describe("connectToBackground", () => {
  test("opens the UI port, reports states and reports, and sends requests", () => {
    const mock = installChromeMock();
    const states: unknown[] = [];
    const reports: unknown[] = [];
    const link = connectToBackground(
      (state) => states.push(state),
      (report) => reports.push(report),
    );
    mock.deliver({ type: "state", state: { status: "connected" } });
    mock.deliver({ type: "report", report: REPORT });
    mock.deliver({ type: "state", state: { status: "haunted" } });
    link.requestStatus();
    link.setSetting("allowUserscripts", false);
    link.reconnect();

    expect(mock.names).toEqual([UI_PORT_NAME]);
    expect(states).toEqual([{ status: "connected" }]);
    expect(reports).toEqual([REPORT]);
    expect(mock.posted).toEqual([
      { type: "status-request" },
      { type: "set", setting: "allowUserscripts", value: false },
      { type: "reconnect" },
    ]);
  });
});

describe("labels and help", () => {
  test("say what Parousia Desktop is doing, with its version once known", () => {
    const connected = { status: "connected" } as const;
    expect(connectionStatusLabel(connected)).toBe("Connected to Parousia Desktop");
    expect(connectionStatusLabel(connected, "1.0.0")).toBe("Connected to Parousia Desktop v1.0.0");
    expect(connectionStatusLabel({ status: "not_allowed" }, "1.0.0")).toBe(
      "Not allowed by Parousia Desktop",
    );
    expect(connectionStatusLabel({ status: "incompatible" })).toBe(
      "Parousia Desktop version mismatch",
    );
    expect(connectionStatusLabel({ status: "disconnected" })).toBe(
      "Not connected to Parousia Desktop",
    );
  });

  test("badges carry a tone for every state", () => {
    expect(connectionBadge({ status: "connected" }, true)).toEqual({
      text: "Connected",
      tone: "good",
    });
    expect(connectionBadge({ status: "connected" }, false)).toEqual({
      text: "Idle",
      tone: "idle",
    });
    expect(connectionBadge({ status: "disconnected" }).tone).toBe("bad");
    expect(connectionBadge({ status: "not_allowed" }).tone).toBe("warn");
    expect(connectionBadge({ status: "connecting" }).tone).toBe("busy");
  });

  test("tell the user what to do, including the exact command to allow this build", () => {
    const origin = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
    expect(connectionHelp({ status: "not_allowed" }, origin)?.command).toBe(
      `Parousia-Desktop allow ${origin}`,
    );
    expect(connectionHelp({ status: "connected" }, origin)).toBeNull();
    expect(connectionHelp({ status: "disconnected" }, origin)?.detail).toContain(
      "Launch Parousia Desktop",
    );
  });

  test("name Parousia in title case, never the all-caps logo form", () => {
    const origin = "chrome-extension://x";
    for (const status of ["not_allowed", "incompatible", "disconnected"] as const) {
      const help = connectionHelp({ status }, origin);
      expect(`${help?.title} ${help?.detail}`).not.toContain("PAROUSIA");
    }
  });
});

describe("the not-found screen", () => {
  const disconnected = { status: "disconnected" } as const;
  const connecting = { status: "connecting" } as const;
  const connected = { status: "connected" } as const;

  test("shows while Desktop is missing, refusing, or a different version", () => {
    expect(isOffline(disconnected)).toBe(true);
    expect(isOffline({ status: "not_allowed" })).toBe(true);
    expect(isOffline({ status: "incompatible" })).toBe(true);
    expect(isOffline(connecting)).toBe(false);
    expect(isOffline(connected)).toBe(false);
  });

  test("stays put while a retry is in flight, instead of flickering", () => {
    expect(displayedState(disconnected, connecting)).toEqual({
      state: disconnected,
      checking: true,
    });
    expect(displayedState(disconnected, connected)).toEqual({ state: connected, checking: false });
    const idle = { status: "idle" } as const;
    expect(displayedState(idle, connecting)).toEqual({ state: connecting, checking: false });
  });
});

describe("Discord-RPC-Extension's app", () => {
  test("Overview mentions it only until Parousia Desktop is connected", () => {
    expect(showsDiscordBridge({ status: "connected" })).toBe(false);
    for (const status of [
      "idle",
      "connecting",
      "disconnected",
      "not_allowed",
      "incompatible",
    ] as const) {
      expect(showsDiscordBridge({ status })).toBe(true);
    }
  });

  test("reads as off, found with its version, or not running", () => {
    expect(discordBridgeLabel({ status: "off", version: null })).toBe("Off");
    expect(discordBridgeLabel({ status: "connected", version: "0.3.0" })).toBe("Connected, v0.3.0");
    expect(discordBridgeLabel({ status: "unavailable", version: null })).toBe("Not running");
    expect(discordBridgeLabel({ status: "connecting", version: null })).toBe("Looking for it…");
  });
});

describe("Parousia Desktop's platforms", () => {
  test("say what each adapter is doing, when Desktop has reported", () => {
    const report = (
      state: AdapterState,
      activity: string | null = null,
      error: string | null = null,
    ): DesktopReport => ({
      ...REPORT,
      platforms: [{ platform: "discord", state, activity, error }],
    });
    expect(desktopPlatformLabel(null, "discord")).toBeNull();
    expect(desktopPlatformLabel(report("idle"), "stoat")).toBeNull();
    expect(desktopPlatformLabel(report("showing", "Jena Hub"), "discord")).toBe("Showing Jena Hub");
    expect(desktopPlatformLabel(report("not_running"), "discord")).toBe("Not running");
    expect(desktopPlatformLabel(report("refused", null, "Invalid Client ID"), "discord")).toBe(
      "Refused: Invalid Client ID",
    );
  });
});
