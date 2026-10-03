import { describe, expect, test } from "bun:test";
import { REPORT } from "./test-desktop";
import { parseUiEvent, parseUiRequest } from "./ui-port";

describe("ui-port messages", () => {
  test("requests are validated before the background acts on them", () => {
    expect(parseUiRequest({ type: "status-request" })).toEqual({ type: "status-request" });
    expect(parseUiRequest({ type: "reconnect" })).toEqual({ type: "reconnect" });
    expect(parseUiRequest({ type: "set", setting: "allowUserscripts", value: true })).toEqual({
      type: "set",
      setting: "allowUserscripts",
      value: true,
    });
    for (const value of [
      { type: "set", setting: "allowedOrigins", value: true },
      { type: "set", setting: "webSocket", value: false },
      { type: "set", setting: "allowUserscripts", value: "off" },
      { type: "allow", origin: "chrome-extension://x" },
      { type: "pair", code: "ABCDE-FGHJK" },
      null,
    ]) {
      expect(parseUiRequest(value)).toBeNull();
    }
  });

  test("events are validated before a UI trusts them", () => {
    expect(
      parseUiEvent({
        type: "state",
        state: { status: "connected", desktopVersion: "1.0.0", update: "desktop", extra: 1 },
      }),
    ).toEqual({
      type: "state",
      state: { status: "connected", desktopVersion: "1.0.0", update: "desktop" },
    });
    expect(parseUiEvent({ type: "state", state: { status: "not_allowed" } })).toEqual({
      type: "state",
      state: { status: "not_allowed" },
    });
    expect(parseUiEvent({ type: "report", report: REPORT })).toEqual({
      type: "report",
      report: REPORT,
    });
    expect(parseUiEvent({ type: "report", report: null })).toEqual({
      type: "report",
      report: null,
    });
    expect(
      parseUiEvent({ type: "discord", state: { status: "connected", version: "0.3.0" } }),
    ).toEqual({ type: "discord", state: { status: "connected", version: "0.3.0" } });
    expect(
      parseUiEvent({
        type: "activity",
        activity: { id: "jena", name: "Jena Hub", configurable: true },
      }),
    ).toEqual({ type: "activity", activity: { id: "jena", name: "Jena Hub", configurable: true } });
    expect(parseUiEvent({ type: "activity", activity: null })).toEqual({
      type: "activity",
      activity: null,
    });
    for (const value of [
      { type: "activity", activity: { name: "No id" } },
      { type: "activity", activity: { id: "x".repeat(257), name: "Long id" } },
      { type: "activity", activity: { id: "a", name: "A", configurable: "yes" } },
      { type: "state", state: { status: "pairing_required" } },
      { type: "state", state: null },
      { type: "state", state: { status: "connected", update: "both" } },
      { type: "state", state: { status: "connected", desktopVersion: 1 } },
      { type: "state", state: { status: "connected", desktopVersion: "1".repeat(33) } },
      { type: "discord", state: { status: "joined", version: null } },
      { type: "discord", state: { status: "connected", version: "x".repeat(33) } },
      { type: "report", report: { version: 1 } },
      "state",
    ]) {
      expect(parseUiEvent(value)).toBeNull();
    }
  });
});
