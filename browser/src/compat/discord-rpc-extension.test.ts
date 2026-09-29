import { describe, expect, test } from "bun:test";
import type { Activity } from "../core/activity";
import {
  startDiscordRpcExtensionCompat,
  toDiscordRpcExtensionResponse,
} from "./discord-rpc-extension";

// docs/api.md's own example id: the right shape, not a real application.
const CLIENT_ID = "606504719212478504";

describe("toDiscordRpcExtensionResponse", () => {
  test("no activity: empty object, not omitted entirely", () => {
    // Discord-RPC-Extension's own contract: a missing response unregisters
    // the integration; {} is the documented way to say "still here, nothing
    // to show".
    expect(toDiscordRpcExtensionResponse(CLIENT_ID, null)).toEqual({});
  });

  test("activity present: clientId plus mapped presence fields", () => {
    const activity: Activity = {
      id: "example",
      name: "Example",
      url: "https://example.com",
      details: "Watching a video",
      state: "In a workspace",
      timestamps: { start: 1_700_000_000_000 },
    };

    expect(toDiscordRpcExtensionResponse(CLIENT_ID, activity)).toEqual({
      clientId: CLIENT_ID,
      presence: {
        state: "In a workspace",
        details: "Watching a video",
        startTimestamp: 1_700_000_000_000,
        instance: true,
      },
    });
  });

  test("activity with no details/state/timestamps still returns a valid presence", () => {
    const activity: Activity = { id: "example", name: "Example", url: "https://example.com" };

    expect(toDiscordRpcExtensionResponse(CLIENT_ID, activity)).toEqual({
      clientId: CLIENT_ID,
      presence: {
        state: undefined,
        details: undefined,
        startTimestamp: undefined,
        instance: true,
      },
    });
  });
});

describe("startDiscordRpcExtensionCompat", () => {
  test("stays inert with no clientId configured, without touching chrome.* at all", () => {
    // No global `chrome` is defined in this test file at all: if the
    // early-return guard for an unset clientId ever gets removed or
    // reordered, this throws (there'd be nothing to call `chrome.runtime.*`
    // on), rather than silently registering under a fake identity.
    expect(() => startDiscordRpcExtensionCompat(() => null)).not.toThrow();
  });
});
