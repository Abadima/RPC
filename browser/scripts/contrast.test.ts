import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { THEME_IDS, type ThemeId } from "../src/shared/appearance";
import {
  CHECKS,
  MIN_TONE_DISTANCE,
  THEME_CSS,
  audit,
  contrast,
  resolveColor,
  themeBlockTokens,
  themeTokens,
  toneDistances,
} from "./contrast";

const css = await Bun.file(THEME_CSS).text();

describe("the audit itself", () => {
  test("measures the WCAG reference points", () => {
    const none = new Map<string, string>();
    expect(contrast(resolveColor("#000", none), resolveColor("#fff", none))).toBeCloseTo(21, 5);
    expect(contrast(resolveColor("#777", none), resolveColor("#fff", none))).toBeCloseTo(4.48, 2);
  });

  test("mixes toward transparent as an alpha, and between colors as CSS does", () => {
    const tokens = new Map([
      ["--a", "#ff0000"],
      ["--b", "var(--a)"],
    ]);
    expect(resolveColor("color-mix(in srgb, var(--b) 25%, transparent)", tokens)).toEqual([
      255, 0, 0, 0.25,
    ]);
    expect(resolveColor("color-mix(in srgb, #000 50%, #fff)", tokens)).toEqual([
      127.5, 127.5, 127.5, 1,
    ]);
  });

  test("an undefined or circular token is an error, not a pass", () => {
    expect(() => resolveColor("var(--missing)", new Map())).toThrow();
    expect(() => resolveColor("var(--x)", new Map([["--x", "var(--x)"]]))).toThrow();
  });
});

describe("theme tokens", () => {
  test("every theme sets the same full set of primitives, so none inherits another's", () => {
    const atelier = themeBlockTokens(css, "atelier").sort();
    expect(atelier.length).toBeGreaterThan(15);
    for (const id of THEME_IDS) expect(themeBlockTokens(css, id).sort()).toEqual(atelier);
  });

  test("themes resolve differently: a later theme's block doesn't leak into Atelier", () => {
    const bg = (id: ThemeId): string | undefined => themeTokens(css, id).get("--bg");
    expect(new Set(THEME_IDS.map(bg)).size).toBe(THEME_IDS.length);
    expect(bg("atelier")).toBe("#2b2322");
  });

  test("components use tokens, never colors of their own", async () => {
    for (const file of [
      THEME_CSS,
      join(import.meta.dir, "..", "src", "fullscreen", "fullscreen.css"),
      join(import.meta.dir, "..", "src", "popup", "popup.css"),
    ]) {
      const source = Bun.file(file);
      const text = (await source.text())
        .replaceAll(/\/\*[\s\S]*?\*\//g, "")
        // Token blocks are the only place a color may be written.
        .replaceAll(/(?<=^|\})\s*(?::root|\[data-theme[^\]]*\])[^{]*\{[^}]*\}/g, "");
      expect({
        file,
        colors: text.match(/(?<=[\s(:,])#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/gi),
      }).toEqual({
        file,
        colors: null,
      });
    }
  });
});

describe("WCAG 2.2 AA", () => {
  const results = audit(css);

  test.each([...THEME_IDS])("every text and non-text pair passes in %s", (theme) => {
    const failures = results
      .filter((result) => result.theme === theme && !result.pass)
      .map(({ check, ratio, required }) => `${check.what}: ${ratio.toFixed(2)} < ${required}`);
    expect(failures).toEqual([]);
  });

  test("every pair is measured in every theme", () => {
    expect(results).toHaveLength(CHECKS.length * THEME_IDS.length);
  });

  test("idle is a hollow ring, told from the filled status dots by shape", () => {
    const rule = /\n\.status-dot \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain("border: 0.1154rem solid var(--text-faint)");
    expect(rule).not.toContain("background");
  });

  test("status colors stay apart from each other in every theme", () => {
    const close = toneDistances(css)
      .filter(({ distance }) => distance < MIN_TONE_DISTANCE)
      .map(({ theme, a, b, distance }) => `${theme}: ${a}/${b} ΔE ${distance.toFixed(1)}`);
    expect(close).toEqual([]);
  });
});
