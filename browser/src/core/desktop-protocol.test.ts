import { describe, expect, test } from "bun:test";
import { createPresence } from "./presence";
import { isDesktopReport, parseServerMessage, presenceWire } from "./desktop-protocol";
import { REPORT } from "./test-desktop";

describe("parseServerMessage", () => {
  test("accepts exactly the messages Desktop sends", () => {
    expect(parseServerMessage({ type: "welcome", protocolVersion: 1, version: "1.0.0" })).toEqual({
      type: "welcome",
      protocolVersion: 1,
      version: "1.0.0",
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
      { type: "welcome", protocolVersion: "3", version: "1.0.0" },
      { type: "welcome", protocolVersion: 1 },
      { type: "welcome", protocolVersion: 1, version: 1 },
      { type: "welcome", protocolVersion: 1, version: "1.0.0-" + "x".repeat(40) },
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

describe("presenceWire", () => {
  test("carries the type, status line, party, and image links, and never the page's address", () => {
    const wire = presenceWire(
      createPresence({
        id: "premid:Example",
        name: "Example",
        url: "https://example.com/watch",
        type: "watching",
        statusDisplayType: "details",
        party: { size: 1, max: 2 },
        assets: {
          largeImage: "a",
          largeUrl: "https://example.com/a",
          smallUrl: "https://example.com/b",
        },
      }),
    );
    expect(wire.activity).toEqual({
      id: "premid:Example",
      name: "Example",
      type: "watching",
      statusDisplayType: "details",
      party: { size: 1, max: 2 },
      assets: {
        largeImage: "a",
        largeUrl: "https://example.com/a",
        smallUrl: "https://example.com/b",
      },
    });
  });
});
