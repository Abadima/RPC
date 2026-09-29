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
    for (const value of [
      { type: "state", state: { status: "pairing_required" } },
      { type: "state", state: null },
      { type: "discord", state: { status: "joined", version: null } },
      { type: "discord", state: { status: "connected", version: "x".repeat(33) } },
      { type: "report", report: { version: 1 } },
      "state",
    ]) {
      expect(parseUiEvent(value)).toBeNull();
    }
  });
});
