import { describe, expect, test } from "bun:test";
import { isDesktopReport, parseServerMessage } from "./desktop-protocol";
import { REPORT } from "./test-desktop";

describe("parseServerMessage", () => {
  test("accepts exactly the messages Desktop sends", () => {
    expect(parseServerMessage({ type: "welcome", protocolVersion: 5 })).toEqual({
      type: "welcome",
      protocolVersion: 5,
    });
    expect(parseServerMessage({ type: "reject", reason: "origin_not_allowed" })).toEqual({
      type: "reject",
      reason: "origin_not_allowed",
    });
    expect(parseServerMessage({ type: "pong" })).toEqual({ type: "pong" });
    expect(parseServerMessage({ type: "status", status: REPORT })).toEqual({
      type: "status",
      status: REPORT,
    });
  });

  test("rejects malformed or unexpected input", () => {
    for (const value of [
      null,
      "welcome",
      [],
      { type: "welcome", protocolVersion: "3" },
      { type: "reject", reason: "because" },
      { type: "challenge", nonce: "x" },
      { type: "status", status: { ...REPORT, clients: [{ id: 1 }] } },
    ]) {
      expect(parseServerMessage(value)).toBeNull();
    }
  });

  test("checks every part of a status report", () => {
    expect(isDesktopReport(REPORT)).toBe(true);
    for (const broken of [
      { ...REPORT, version: 1 },
      { ...REPORT, transport: { ...REPORT.transport, sameUserCheck: "yes" } },
      { ...REPORT, settings: { ...REPORT.settings, allowUserscripts: "no" } },
      { ...REPORT, settings: { ...REPORT.settings, allowedOrigins: [1] } },
      { ...REPORT, events: [{ secsAgo: 1 }] },
      { ...REPORT, refused: "none" },
      { ...REPORT, platforms: undefined },
      {
        ...REPORT,
        platforms: [{ platform: "discord", state: "dancing", activity: null, error: null }],
      },
      {
        ...REPORT,
        platforms: [{ platform: "discord", state: "showing", activity: 1, error: null }],
      },
    ]) {
      expect(isDesktopReport(broken)).toBe(false);
    }
  });
});
