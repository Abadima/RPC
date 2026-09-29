import { describe, expect, test } from "bun:test";
import type { Activity } from "./activity";
import {
  DEFAULT_PREFERENCES,
  applyPreferences,
  formatIdleTimeout,
  loadPreferences,
  parsePreferences,
  savePreferences,
  stepIdleTimeout,
  type PreferenceArea,
} from "./preferences";

function memoryArea(): PreferenceArea & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = {};
  return {
    data,
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (items) => {
      Object.assign(data, items);
    },
  };
}

const activity: Activity = {
  id: "jena",
  name: "Jena",
  details: "Reading a page",
  state: "Documentation",
  url: "https://jena.systems",
  assets: { largeImage: "logo", largeText: "Page title", smallImage: "dot", smallText: "Reading" },
};

describe("parsePreferences", () => {
  test("nothing stored means the defaults", () => {
    expect(parsePreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
  });

  test("invalid fields fall back one by one, valid ones are kept", () => {
    expect(
      parsePreferences({
        language: "xx",
        shareMediaDetails: false,
        idleTimeoutMinutes: 7,
        incognito: "reveal",
        platforms: { discord: false, fluxer: "yes" },
        discordRpcExtension: "no",
      }),
    ).toEqual({
      ...DEFAULT_PREFERENCES,
      shareMediaDetails: false,
      platforms: { discord: false, fluxer: true, stoat: true },
    });
  });
});

describe("idle timeout", () => {
  test("steps through the allowed values and stops at the ends", () => {
    expect(stepIdleTimeout(0, 1)).toBe(1);
    expect(stepIdleTimeout(5, -1)).toBe(2);
    expect(stepIdleTimeout(0, -1)).toBe(0);
    expect(stepIdleTimeout(60, 1)).toBe(60);
  });

  test("reads as a short label", () => {
    expect(formatIdleTimeout(0)).toBe("Off");
    expect(formatIdleTimeout(5)).toBe("5 min");
    expect(formatIdleTimeout(60)).toBe("1 h");
  });
});

describe("applyPreferences", () => {
  test("shares everything by default", () => {
    expect(applyPreferences(activity, DEFAULT_PREFERENCES)).toEqual(activity);
  });

  test("without media details only the name, link, and images remain", () => {
    const shared = applyPreferences(activity, { ...DEFAULT_PREFERENCES, shareMediaDetails: false });
    expect(shared).toEqual({
      id: "jena",
      name: "Jena",
      url: "https://jena.systems",
      assets: { largeImage: "logo", smallImage: "dot" },
    });
  });

  test("private tabs share nothing unless allowed", () => {
    expect(applyPreferences(activity, DEFAULT_PREFERENCES, true)).toBeNull();
    expect(
      applyPreferences(activity, { ...DEFAULT_PREFERENCES, incognito: "share" }, true),
    ).toEqual(activity);
  });
});

describe("storage", () => {
  test("saves a change on top of what's stored and reads it back", async () => {
    const area = memoryArea();
    expect(await loadPreferences(area)).toEqual(DEFAULT_PREFERENCES);
    await savePreferences({ idleTimeoutMinutes: 5 }, area);
    const saved = await savePreferences({ incognito: "share" }, area);
    expect(saved).toEqual({ ...DEFAULT_PREFERENCES, idleTimeoutMinutes: 5, incognito: "share" });
    expect(await loadPreferences(area)).toEqual(saved);
  });
});
