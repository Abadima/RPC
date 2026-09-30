import { describe, expect, test } from "bun:test";
import type { ActivityInfo } from "./activity";
import {
  allowedData,
  chosenVariant,
  isActivityOn,
  loadActivityStates,
  needsAccess,
  parseActivityStates,
  saveActivityState,
  settingShown,
  settingValues,
} from "./activity-state";
import type { PreferenceArea } from "./preferences";
import { ActivityRegistry } from "./registry";

const native: ActivityInfo = {
  id: "native",
  name: "Native",
  hosts: ["example.com"],
  source: "parousia",
  settings: [
    { id: "buttons", title: "Buttons", type: "boolean", default: true },
    { id: "image", title: "Image", type: "choice", default: 1, choices: ["Logo", "Cover", "None"] },
    { id: "label", title: "Label", type: "text", default: "%title%", when: { buttons: true } },
    { id: "minutes", title: "Minutes", type: "number", default: 5 },
  ],
};
const premid: ActivityInfo = {
  id: "premid:Example",
  name: "Example",
  hosts: ["example.com"],
  source: "premid",
  origins: ["*://example.com/*"],
};

function memoryArea(): PreferenceArea & { stored: Record<string, unknown> } {
  const area = {
    stored: {} as Record<string, unknown>,
    get: async (key: string) => ({ [key]: area.stored[key] }),
    set: async (items: Record<string, unknown>) => {
      Object.assign(area.stored, items);
    },
  };
  return area;
}

describe("Activity state", () => {
  test("URL-and-title Activities are on until turned off; page-reading ones off until turned on", () => {
    expect(isActivityOn(native, {})).toBe(true);
    expect(isActivityOn(premid, {})).toBe(false);
    expect(isActivityOn(native, { native: { on: false } })).toBe(false);
    expect(isActivityOn(premid, { "premid:Example": { on: true } })).toBe(true);
  });

  test("settings are as stored when they fit, or at their defaults", () => {
    expect(settingValues(native)).toEqual({
      buttons: true,
      image: 1,
      label: "%title%",
      minutes: 5,
    });
    const values = settingValues(native, {
      native: { settings: { buttons: false, image: 7, label: 3, minutes: 30, unknown: true } },
    });
    expect(values).toEqual({ buttons: false, image: 1, label: "%title%", minutes: 30 });
  });

  test("a setting shows while its conditions hold and its Activity hasn't hidden it", () => {
    const label = native.settings?.[2];
    if (!label) throw new Error("fixture");
    expect(settingShown(label, { buttons: true })).toBe(true);
    expect(settingShown(label, { buttons: false })).toBe(false);
    expect(settingShown(label, { buttons: true }, ["label"])).toBe(false);
  });

  test("anything stored that isn't a state is dropped", () => {
    expect(
      parseActivityStates({
        good: {
          on: true,
          settings: { a: 1, b: { nested: true }, c: "x".repeat(300) },
          hidden: ["a", 2],
        },
        bad: "on",
        [`${"x".repeat(300)}`]: { on: true },
      }),
    ).toEqual({ good: { on: true, settings: { a: 1 }, hidden: ["a"] } });
    expect(parseActivityStates(null)).toEqual({});
  });

  test("saving merges settings one by one", async () => {
    const area = memoryArea();
    await saveActivityState("native", { settings: { buttons: false } }, area);
    await saveActivityState("native", { on: false, settings: { image: 2 } }, area);
    expect(await loadActivityStates(area)).toEqual({
      native: { on: false, settings: { buttons: false, image: 2 } },
    });
  });

  test("page data it declares, minus what Settings > Privacy switches off for every Activity", () => {
    const reader: ActivityInfo = { ...premid, data: ["media", "thumbnails", "creatorIcons"] };
    const all = { media: true, thumbnails: true, creatorIcons: true };
    expect(allowedData(reader, all)).toEqual(["media", "thumbnails", "creatorIcons"]);
    expect(allowedData(reader, { ...all, thumbnails: false })).toEqual(["media", "creatorIcons"]);
    expect(allowedData(native, all)).toEqual([]);
    // Per-Activity switches from before are dropped, not honored.
    expect(parseActivityStates({ x: { on: true, denied: ["media"] } })).toEqual({
      x: { on: true },
    });
  });

  test("an Activity that reads pages is off until turned on; one that doesn't is on until turned off", () => {
    const reader: ActivityInfo = { ...native, id: "reader", origins: ["https://example.com/*"] };
    expect(needsAccess(native)).toBe(false);
    expect(needsAccess(reader)).toBe(true);
    expect(isActivityOn(native, {})).toBe(true);
    expect(isActivityOn(reader, {})).toBe(false);
    expect(isActivityOn(reader, { reader: { on: true } })).toBe(true);
    expect(isActivityOn(native, { [native.id]: { on: false } })).toBe(false);
  });

  test("of a website's implementations, only the chosen one is on: the first, until another is picked", () => {
    const variants = [native.id, premid.id];
    const mine: ActivityInfo = { ...native, variants };
    const theirs: ActivityInfo = { ...premid, variants };
    const states = { [premid.id]: { on: true } };
    expect(chosenVariant(theirs, states)).toBe(native.id);
    expect(isActivityOn(mine, states)).toBe(true);
    expect(isActivityOn(theirs, states)).toBe(false);
    const picked = { ...states, [native.id]: { use: premid.id } };
    expect(isActivityOn(mine, picked)).toBe(false);
    expect(isActivityOn(theirs, picked)).toBe(true);
    // A choice that isn't one of its variants falls back to the first.
    expect(chosenVariant(theirs, { [native.id]: { use: "premid:Elsewhere" } })).toBe(native.id);
    expect(parseActivityStates({ [native.id]: { use: 3 } })).toEqual({ [native.id]: {} });
  });
});

describe("a website in both sources", () => {
  const variants = [native.id, premid.id];
  const mine: ActivityInfo = { ...native, variants };
  const theirs: ActivityInfo = { ...premid, variants };
  const page = new URL("https://example.com/watch");

  function registry(): ActivityRegistry {
    const registry = new ActivityRegistry();
    // Native ones are registered first, as the background does.
    for (const info of [mine, theirs]) {
      registry.register({ info, matcher: () => true, detect: () => null });
    }
    return registry;
  }

  test("the native implementation runs by default, whether or not PreMiD's is turned on", () => {
    for (const states of [{}, { [premid.id]: { on: true } }, { [native.id]: { use: "junk" } }]) {
      const resolved = registry().resolve(page, (info) => isActivityOn(info, states));
      expect(resolved?.info.id).toBe(native.id);
    }
  });

  test("PreMiD's runs only once someone picks it, and then the native one doesn't", () => {
    const states = { [native.id]: { use: premid.id }, [premid.id]: { on: true } };
    expect(registry().resolve(page, (info) => isActivityOn(info, states))?.info.id).toBe(premid.id);
    // Picked but not turned on: neither runs, rather than falling back to the other.
    const off = { [native.id]: { use: premid.id } };
    expect(registry().resolve(page, (info) => isActivityOn(info, off))).toBeNull();
  });

  test("never both, whatever is stored", () => {
    const flags = [undefined, true, false];
    const choices = [undefined, native.id, premid.id, "junk"];
    for (const nativeOn of flags) {
      for (const premidOn of flags) {
        for (const use of choices) {
          const states = parseActivityStates({
            [native.id]: {
              ...(nativeOn === undefined ? {} : { on: nativeOn }),
              ...(use ? { use } : {}),
            },
            [premid.id]: premidOn === undefined ? {} : { on: premidOn },
          });
          const running = [mine, theirs].filter((info) => isActivityOn(info, states));
          expect(running.length).toBeLessThanOrEqual(1);
          // What runs is the chosen implementation, and only that one.
          for (const info of running) expect(chosenVariant(info, states)).toBe(info.id);
        }
      }
    }
  });
});
