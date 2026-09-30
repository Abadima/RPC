import { describe, expect, test } from "bun:test";
import type { PreferenceArea } from "../core/preferences";
import {
  DEFAULT_THEME,
  THEME_IDS,
  THEME_LABELS,
  applyTheme,
  loadTheme,
  parseTheme,
  readThemeHint,
  saveTheme,
  type HintStore,
} from "./appearance";

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

function memoryHints(): HintStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
  };
}

const blocked: HintStore = {
  getItem: () => {
    throw new DOMException("blocked", "SecurityError");
  },
  setItem: () => {
    throw new DOMException("full", "QuotaExceededError");
  },
};

describe("themes", () => {
  test("Atelier, Botanique, and Monolith, with Atelier the default", () => {
    expect(THEME_IDS).toEqual(["atelier", "botanique", "monolith"]);
    expect(Object.keys(THEME_LABELS)).toEqual([...THEME_IDS]);
    expect(DEFAULT_THEME).toBe("atelier");
  });

  test("anything but a known id reads as the default", () => {
    for (const id of ["atelier", "botanique", "monolith"] as const) expect(parseTheme(id)).toBe(id);
    for (const junk of [undefined, null, "", "Botanique", "light", 1, {}, ["monolith"]])
      expect(parseTheme(junk)).toBe("atelier");
  });
});

describe("persistence", () => {
  test("nothing stored means Atelier", async () => {
    expect(await loadTheme(memoryArea())).toBe("atelier");
  });

  test("a saved theme loads back, under its own key", async () => {
    const area = memoryArea();
    await saveTheme("monolith", area);
    expect(area.data).toEqual({ theme: "monolith" });
    expect(await loadTheme(area)).toBe("monolith");
    await saveTheme("botanique", area);
    expect(await loadTheme(area)).toBe("botanique");
  });

  test("a corrupted stored value falls back to Atelier", async () => {
    const area = memoryArea();
    area.data.theme = "<img src=x onerror=alert(1)>";
    expect(await loadTheme(area)).toBe("atelier");
  });

  test("never touches Preferences", async () => {
    const area = memoryArea();
    area.data.preferences = { language: "en" };
    await saveTheme("botanique", area);
    expect(area.data.preferences).toEqual({ language: "en" });
  });
});

describe("first paint", () => {
  test("applying sets data-theme and caches it for the next page", () => {
    const root = { dataset: {} as DOMStringMap };
    const hints = memoryHints();
    applyTheme("botanique", root, hints);
    expect(root.dataset.theme).toBe("botanique");
    expect(readThemeHint(hints)).toBe("botanique");
  });

  test("only one theme at a time: switching replaces it", () => {
    const root = { dataset: {} as DOMStringMap };
    const hints = memoryHints();
    applyTheme("monolith", root, hints);
    applyTheme("atelier", root, hints);
    expect(root.dataset).toEqual({ theme: "atelier" });
  });

  test("an unknown value is never written to the page", () => {
    const root = { dataset: {} as DOMStringMap };
    const hints = memoryHints();
    hints.data.set("parousia-theme", '"] * { display: none } [x="');
    applyTheme(readThemeHint(hints), root, hints);
    expect(root.dataset.theme).toBe("atelier");
  });

  test("no cache, or a blocked one, means Atelier and no error", () => {
    expect(readThemeHint(null)).toBe("atelier");
    expect(readThemeHint(memoryHints())).toBe("atelier");
    expect(readThemeHint(blocked)).toBe("atelier");
    const root = { dataset: {} as DOMStringMap };
    expect(() => applyTheme("monolith", root, blocked)).not.toThrow();
    expect(root.dataset.theme).toBe("monolith");
  });
});
