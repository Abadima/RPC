import { describe, expect, test } from "bun:test";
import type { Activity } from "./activity";
import {
  DEFAULT_PREFERENCES,
  applyPreferences,
  enabledPlatforms,
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
  detailsUrl: "https://jena.systems/docs",
  stateUrl: "https://jena.systems/",
  buttons: [{ label: "Read it", url: "https://jena.systems/docs" }],
  discordClientId: "1553980756731363428",
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
        pageData: { media: false, thumbnails: "no", passwords: true },
      }),
    ).toEqual({
      ...DEFAULT_PREFERENCES,
      shareMediaDetails: false,
      platforms: { discord: false, fluxer: true, stoat: true },
      pageData: { media: false, thumbnails: true, creatorIcons: true },
    });
  });

  test("MAL-Sync is off until someone turns it on, and only a boolean counts", () => {
    expect(DEFAULT_PREFERENCES.malSync).toBe(false);
    expect(parsePreferences({ malSync: true }).malSync).toBe(true);
    expect(parsePreferences({ malSync: "yes" }).malSync).toBe(false);
  });

  test("every kind of page data is allowed until switched off", () => {
    expect(DEFAULT_PREFERENCES.pageData).toEqual({
      media: true,
      thumbnails: true,
      creatorIcons: true,
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
  test("without media details, a name an Activity set from the page becomes its own again", () => {
    const song = { ...activity, name: "Never Gonna Give You Up" };
    const off = { ...DEFAULT_PREFERENCES, shareMediaDetails: false };
    expect(applyPreferences(song, off, false, "Jena Hub")?.name).toBe("Jena Hub");
    expect(applyPreferences(song, DEFAULT_PREFERENCES, false, "Jena Hub")?.name).toBe(
      "Never Gonna Give You Up",
    );
  });

  test("shares everything by default", () => {
    expect(applyPreferences(activity, DEFAULT_PREFERENCES)).toEqual(activity);
  });

  test("without media details only the name, link, and images remain", () => {
    const shared = applyPreferences(activity, { ...DEFAULT_PREFERENCES, shareMediaDetails: false });
    expect(shared).toEqual({
      id: "jena",
      name: "Jena",
      url: "https://jena.systems",
      discordClientId: "1553980756731363428",
      assets: { largeImage: "logo", smallImage: "dot" },
    });
  });

  test("without media details the kind of Activity stays, and what describes the media goes", () => {
    const watching: Activity = {
      ...activity,
      type: "watching",
      statusDisplayType: "details",
      party: { size: 1, max: 2 },
      assets: {
        largeImage: "logo",
        largeUrl: "https://jena.systems/a",
        smallUrl: "https://jena.systems/b",
      },
    };
    expect(
      applyPreferences(watching, { ...DEFAULT_PREFERENCES, shareMediaDetails: false }),
    ).toEqual({
      id: "jena",
      name: "Jena",
      url: "https://jena.systems",
      discordClientId: "1553980756731363428",
      type: "watching",
      assets: { largeImage: "logo", smallImage: undefined },
    });
  });

  test("lists the platforms turned on, in order", () => {
    expect(enabledPlatforms(DEFAULT_PREFERENCES)).toEqual(["discord", "fluxer", "stoat"]);
    const noDiscord = { ...DEFAULT_PREFERENCES.platforms, discord: false };
    expect(enabledPlatforms({ ...DEFAULT_PREFERENCES, platforms: noDiscord })).toEqual([
      "fluxer",
      "stoat",
    ]);
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
