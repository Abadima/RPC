import { describe, expect, test } from "bun:test";
import mapping from "../../../adapters/discord/activity-mapping.json";
import type { Activity } from "../core/activity";
import {
  startDiscordRpcExtensionCompat,
  toDiscordPresence,
  toDiscordRpcExtensionResponse,
  type DiscordRpcExtensionPresence,
} from "./discord-rpc-extension";

// docs/api.md's own example id: the right shape, not a real application.
const CLIENT_ID = "606504719212478504";

/**
 * What Discord-RPC-Extension's app turns a presence into: @xhayper/discord-rpc's
 * `setActivity` (src/structures/ClientUser.ts), minus the `type` and
 * `created_at` it adds on its own. Truthy checks, as there.
 */
function asDiscordActivity(p: DiscordRpcExtensionPresence): unknown {
  const assets = {
    large_image: p.largeImageKey || undefined,
    large_text: p.largeImageText || undefined,
    small_image: p.smallImageKey || undefined,
    small_text: p.smallImageText || undefined,
  };
  const activity = {
    name: p.name,
    details: p.details || undefined,
    details_url: p.detailsUrl || undefined,
    state: p.state || undefined,
    state_url: p.stateUrl || undefined,
    timestamps:
      p.startTimestamp || p.endTimestamp
        ? { start: p.startTimestamp, end: p.endTimestamp }
        : undefined,
    assets: Object.values(assets).some(Boolean) ? assets : undefined,
    buttons: p.buttons?.length ? p.buttons : undefined,
    instance: !!p.instance,
  };
  return JSON.parse(JSON.stringify(activity));
}

describe("toDiscordPresence", () => {
  test("matches the cases Desktop's Discord adapter is tested against", () => {
    expect(mapping.cases.length).toBeGreaterThanOrEqual(5);
    for (const { name, activity, discord } of mapping.cases) {
      const shown = asDiscordActivity(toDiscordPresence(activity as Activity));
      expect({ name, shown }).toEqual({ name, shown: discord });
    }
  });

  test("drops what Desktop would already refuse", () => {
    const presence = toDiscordPresence({
      id: "x",
      name: "Example",
      url: "https://example.com",
      detailsUrl: "javascript:alert(1)",
      timestamps: { start: 1.5 },
      buttons: [
        { label: "One", url: "file:///etc/passwd" },
        { label: "Two", url: "https://a.example" },
        { label: "Three", url: "https://b.example" },
        { label: "Four", url: "https://c.example" },
      ],
    });
    expect(JSON.parse(JSON.stringify(presence))).toEqual({
      name: "Example",
      buttons: [
        { label: "Two", url: "https://a.example" },
        { label: "Three", url: "https://b.example" },
      ],
      instance: true,
    });
  });
});

describe("toDiscordRpcExtensionResponse", () => {
  test("no activity: empty object, not omitted entirely", () => {
    // Discord-RPC-Extension's own contract: a missing response unregisters
    // the integration; {} is the documented way to say "still here, nothing
    // to show".
    expect(toDiscordRpcExtensionResponse(CLIENT_ID, null)).toEqual({});
  });

  test("activity present: clientId plus the mapped presence", () => {
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
        name: "Example",
        state: "In a workspace",
        details: "Watching a video",
        startTimestamp: 1_700_000_000_000,
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
