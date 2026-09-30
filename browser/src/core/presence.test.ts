import { describe, expect, test } from "bun:test";
import type { Activity } from "./activity";
import { createPresence, presenceEquals } from "./presence";

function activity(overrides: Partial<Activity> = {}): Activity {
  return { id: "example", name: "Example", url: "https://example.com", ...overrides };
}

describe("presenceEquals", () => {
  test("two null activities are equal", () => {
    expect(presenceEquals(createPresence(null), createPresence(null))).toBe(true);
  });

  test("a null activity and a present one are not equal", () => {
    expect(presenceEquals(createPresence(null), createPresence(activity()))).toBe(false);
  });

  test("activities with the same fields are equal even as distinct objects", () => {
    expect(presenceEquals(createPresence(activity()), createPresence(activity()))).toBe(true);
  });

  test("activities differing only in details are not equal", () => {
    const a = createPresence(activity({ details: "Watching a video" }));
    const b = createPresence(activity({ details: "Reading an article" }));
    expect(presenceEquals(a, b)).toBe(false);
  });

  test("matching nested assets/timestamps are equal", () => {
    const a = createPresence(
      activity({ assets: { largeImage: "cover.png" }, timestamps: { start: 100 } }),
    );
    const b = createPresence(
      activity({ assets: { largeImage: "cover.png" }, timestamps: { start: 100 } }),
    );
    expect(presenceEquals(a, b)).toBe(true);
  });

  test("differing nested assets are not equal", () => {
    const a = createPresence(activity({ assets: { largeImage: "cover.png" } }));
    const b = createPresence(activity({ assets: { largeImage: "other.png" } }));
    expect(presenceEquals(a, b)).toBe(false);
  });

  test("links, buttons, and the Discord Application count as changes", () => {
    const base = activity({ buttons: [{ label: "Open", url: "https://example.com" }] });
    const same = activity({ buttons: [{ label: "Open", url: "https://example.com" }] });
    expect(presenceEquals(createPresence(base), createPresence(same))).toBe(true);
    for (const changed of [
      activity({ buttons: [{ label: "Play", url: "https://example.com" }] }),
      activity({ buttons: [] }),
      activity({ ...base, detailsUrl: "https://example.com/d" }),
      activity({ ...base, stateUrl: "https://example.com/s" }),
      activity({ ...base, discordClientId: "1553980756731363428" }),
    ]) {
      expect(presenceEquals(createPresence(base), createPresence(changed))).toBe(false);
    }
  });
});
