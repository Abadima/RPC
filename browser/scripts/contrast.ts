/**
 * WCAG 2.2 AA contrast audit of src/shared/theme.css. For each theme it runs
 * the token cascade the way a browser does for <html data-theme=…> (the
 * token blocks are all one specificity, so source order decides), resolves
 * every token to a color (hex, `var()`, and `color-mix(in srgb, …)`), and
 * measures every pair the popup and dashboard draw. `bun run contrast`
 * prints the table; contrast.test.ts fails on any pair under AA.
 */
import { join } from "node:path";
import { THEME_IDS, type ThemeId } from "../src/shared/appearance";

type Rgba = readonly [r: number, g: number, b: number, a: number];

/** Top-level blocks only: at-rules (@font-face, @media, @keyframes) never hold tokens. */
function topLevelBlocks(css: string): Array<{ selector: string; body: string }> {
  const source = css.replaceAll(/\/\*[\s\S]*?\*\//g, "");
  const blocks: Array<{ selector: string; body: string }> = [];
  let depth = 0;
  let start = 0;
  let selector = "";
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === "{") {
      if (depth === 0) {
        selector = source.slice(start, i).trim();
        start = i + 1;
      }
      depth++;
    } else if (char === "}") {
      depth--;
      if (depth === 0) {
        if (!selector.startsWith("@")) blocks.push({ selector, body: source.slice(start, i) });
        start = i + 1;
      }
    }
  }
  return blocks;
}

function matchesTheme(selector: string, theme: ThemeId): boolean {
  return selector
    .split(",")
    .map((part) => part.trim())
    .some(
      (part) => part === ":root" || part === "[data-theme]" || part === `[data-theme="${theme}"]`,
    );
}

/** Every custom property <html data-theme=theme> ends up with, unresolved. */
export function themeTokens(css: string, theme: ThemeId): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const { selector, body } of topLevelBlocks(css)) {
    if (!matchesTheme(selector, theme)) continue;
    for (const declaration of body.split(";")) {
      const match = /^\s*(--[\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(declaration);
      if (match?.[1] && match[2]) tokens.set(match[1], match[2]);
    }
  }
  return tokens;
}

/** The token names a theme block itself sets: every theme must set the same ones. */
export function themeBlockTokens(css: string, theme: ThemeId): string[] {
  const own = topLevelBlocks(css).find(({ selector }) =>
    selector.split(",").some((part) => part.trim() === `[data-theme="${theme}"]`),
  );
  if (!own) return [];
  return [...own.body.matchAll(/(--[\w-]+)\s*:/g)].flatMap((match) => (match[1] ? [match[1]] : []));
}

/** Splits on commas outside parentheses. */
function splitArgs(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth--;
    else if (value[i] === "," && depth === 0) {
      parts.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts;
}

export function resolveColor(
  value: string,
  tokens: ReadonlyMap<string, string>,
  seen = new Set<string>(),
): Rgba {
  const text = value.trim();
  if (text === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    const byte = (at: number): number => Number.parseInt(full.slice(at, at + 2), 16);
    return [byte(0), byte(2), byte(4), 1];
  }
  const reference = /^var\((--[\w-]+)\)$/.exec(text)?.[1];
  if (reference) {
    const next = tokens.get(reference);
    if (next === undefined) throw new Error(`${reference} isn't defined`);
    if (seen.has(reference)) throw new Error(`${reference} refers to itself`);
    return resolveColor(next, tokens, new Set(seen).add(reference));
  }
  const mix = /^color-mix\(\s*in srgb\s*,([\s\S]+)\)$/.exec(text)?.[1];
  if (mix) {
    const [first = "", second = ""] = splitArgs(mix);
    const weighted = (part: string): [Rgba, number | null] => {
      const found = /^([\s\S]+?)\s+(\d+(?:\.\d+)?)%$/.exec(part);
      return found?.[1] && found[2]
        ? [resolveColor(found[1], tokens, seen), Number(found[2]) / 100]
        : [resolveColor(part, tokens, seen), null];
    };
    const [a, pa] = weighted(first);
    const [b, pb] = weighted(second);
    const p1 = pa ?? (pb === null ? 0.5 : 1 - pb);
    const p2 = pb ?? 1 - p1;
    // CSS Color 5: premultiplied interpolation.
    const alpha = a[3] * p1 + b[3] * p2;
    if (alpha === 0) return [0, 0, 0, 0];
    const channel = (i: 0 | 1 | 2): number => (a[i] * a[3] * p1 + b[i] * b[3] * p2) / alpha;
    return [channel(0), channel(1), channel(2), alpha];
  }
  throw new Error(`can't audit the color "${text}"`);
}

/** `top` drawn over an opaque `bottom`. */
function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top[3];
  const blend = (i: 0 | 1 | 2): number => top[i] * a + bottom[i] * (1 - a);
  return [blend(0), blend(1), blend(2), 1];
}

function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: Rgba): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrast(a: Rgba, b: Rgba): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** CIELAB (D65), for how far apart two status colors look. */
function lab(color: Rgba): [number, number, number] {
  const [r, g, b] = [linear(color[0]), linear(color[1]), linear(color[2])];
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number): number => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76 ΔE: about 2 is barely visible, over 20 reads as a different color at a glance. */
export function deltaE(a: Rgba, b: Rgba): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/**
 * What the UI draws: a foreground token over a stack of background tokens
 * (bottom first, opaque), and the ratio AA asks of it. 4.5 for text, 3 for
 * large text (panel titles) and for anything that isn't text but is needed
 * to see a control, its state, or focus (WCAG 1.4.3, 1.4.11, 2.4.7).
 * Disabled controls are exempt under 1.4.3 and aren't listed.
 */
interface Check {
  kind: "text" | "large text" | "non-text";
  what: string;
  fg: string;
  on: readonly string[];
}

const TEXT = 4.5;
const NON_TEXT = 3;

const BASES = ["--bg", "--surface", "--surface-raised", "--field"] as const;

export const CHECKS: readonly Check[] = [
  // Text
  ...BASES.map((on): Check => ({ kind: "text", what: "Body text", fg: "--text", on: [on] })),
  {
    kind: "text",
    what: "Selected row, nav link, or segment",
    fg: "--text",
    on: ["--surface", "--accent-soft"],
  },
  { kind: "text", what: "Hovered nav link or quiet button", fg: "--text", on: ["--bg", "--hover"] },
  { kind: "text", what: "Hovered sidebar nav link", fg: "--text", on: ["--surface", "--hover"] },
  ...BASES.map((on): Check => ({
    kind: "text",
    what: "Secondary text",
    fg: "--text-muted",
    on: [on],
  })),
  {
    kind: "text",
    what: "Idle badge, quiet pill",
    fg: "--text-muted",
    on: ["--bg", "--neutral-soft"],
  },
  {
    kind: "text",
    what: "Idle badge on a card",
    fg: "--text-muted",
    on: ["--surface", "--neutral-soft"],
  },
  { kind: "text", what: "Error banner detail", fg: "--text-muted", on: ["--bg", "--bad-wash"] },
  { kind: "text", what: "Warning banner detail", fg: "--text-muted", on: ["--bg", "--warn-wash"] },
  ...(["--bg", "--surface", "--field"] as const).map((on): Check => ({
    kind: "text",
    what: "Labels, placeholders, hints",
    fg: "--text-faint",
    on: [on],
  })),
  { kind: "text", what: "Accent text", fg: "--accent-text", on: ["--bg"] },
  { kind: "text", what: "Accent text on a card", fg: "--accent-text", on: ["--surface"] },
  {
    kind: "text",
    what: "Pill, tile, busy badge",
    fg: "--accent-text",
    on: ["--surface", "--accent-soft"],
  },
  { kind: "text", what: "Busy badge", fg: "--accent-text", on: ["--bg", "--accent-soft"] },
  {
    kind: "text",
    what: "Elapsed time on the presence card",
    fg: "--accent-text",
    on: ["--surface", "--accent-glow"],
  },
  { kind: "text", what: "Button label", fg: "--on-accent", on: ["--accent"] },
  { kind: "text", what: "Hovered button label", fg: "--on-accent", on: ["--accent-hover"] },
  { kind: "text", what: "Connected status on a card", fg: "--good-text", on: ["--surface"] },
  { kind: "text", what: "Connected badge", fg: "--good-text", on: ["--bg", "--good-soft"] },
  { kind: "text", what: "Warning text", fg: "--warn-text", on: ["--bg"] },
  {
    kind: "text",
    what: "Warning pill on a card",
    fg: "--warn-text",
    on: ["--surface", "--warn-soft"],
  },
  { kind: "text", what: "Warning badge", fg: "--warn-text", on: ["--bg", "--warn-soft"] },
  { kind: "text", what: "Settings note", fg: "--warn-text", on: ["--surface", "--warn-wash"] },
  { kind: "text", what: "Error text", fg: "--bad-text", on: ["--bg"] },
  { kind: "text", what: "Field error on a card", fg: "--bad-text", on: ["--surface"] },
  { kind: "text", what: "Disconnected badge", fg: "--bad-text", on: ["--bg", "--bad-soft"] },
  { kind: "large text", what: "Page title", fg: "--text", on: ["--bg"] },

  // Controls, states, and focus
  ...BASES.map((on): Check => ({ kind: "non-text", what: "Focus ring", fg: "--focus", on: [on] })),
  {
    kind: "non-text",
    what: "Focus ring beside a selected row",
    fg: "--focus",
    on: ["--surface", "--accent-soft"],
  },
  {
    kind: "non-text",
    what: "Field, select, search outline",
    fg: "--control-line",
    on: ["--field"],
  },
  { kind: "non-text", what: "Field outline on a card", fg: "--control-line", on: ["--surface"] },
  { kind: "non-text", what: "Field outline on the page", fg: "--control-line", on: ["--bg"] },
  { kind: "non-text", what: "Selected row, theme, or page", fg: "--selection", on: ["--surface"] },
  { kind: "non-text", what: "Selected segment", fg: "--selection", on: ["--field"] },
  { kind: "non-text", what: "Current page in the pager", fg: "--accent", on: ["--bg"] },
  { kind: "non-text", what: "Switch knob, on", fg: "--on-accent", on: ["--accent"] },
  { kind: "non-text", what: "Switch knob, off", fg: "--text", on: ["--surface", "--track"] },
  { kind: "non-text", what: "Invalid field outline", fg: "--bad", on: ["--field"] },
  {
    kind: "non-text",
    what: "Icons in a hovered row",
    fg: "--text-faint",
    on: ["--surface-raised"],
  },
  ...(["--good", "--accent-text", "--warn", "--bad"] as const).flatMap((fg) =>
    (["--bg", "--surface"] as const).map((on): Check => ({
      kind: "non-text",
      what: `Status dot (${fg.slice(2)})`,
      fg,
      on: [on],
    })),
  ),
];

/**
 * The filled status dots, which must look different from each other on a
 * card: every status also has a label, but the dot is what's seen at a
 * glance. Idle isn't here: it's a hollow ring (contrast.test.ts keeps it one).
 */
export const TONES = [
  ["connected", "--good"],
  ["connecting", "--accent-text"],
  ["warning", "--warn"],
  ["error", "--bad"],
] as const;
export const MIN_TONE_DISTANCE = 20;

export interface Result {
  theme: ThemeId;
  check: Check;
  ratio: number;
  required: number;
  pass: boolean;
}

export function audit(css: string): Result[] {
  return THEME_IDS.flatMap((id) => {
    const tokens = themeTokens(css, id);
    const color = (token: string): Rgba => resolveColor(`var(${token})`, tokens);
    return CHECKS.map((check) => {
      const [base = "", ...layers] = check.on;
      const background = layers.reduce((under, token) => over(color(token), under), color(base));
      if (background[3] !== 1) throw new Error(`${base} must be opaque to sit at the bottom`);
      const ratio = contrast(over(color(check.fg), background), background);
      const required = check.kind === "text" ? TEXT : NON_TEXT;
      return { theme: id, check, ratio, required, pass: ratio >= required };
    });
  });
}

export function toneDistances(
  css: string,
): Array<{ theme: ThemeId; a: string; b: string; distance: number }> {
  return THEME_IDS.flatMap((id) => {
    const tokens = themeTokens(css, id);
    const color = (token: string): Rgba => resolveColor(`var(${token})`, tokens);
    return TONES.flatMap(([a, ta], i) =>
      TONES.slice(i + 1).map(([b, tb]) => ({
        theme: id,
        a,
        b,
        distance: deltaE(over(color(ta), color("--surface")), over(color(tb), color("--surface"))),
      })),
    );
  });
}

export const THEME_CSS = join(import.meta.dir, "..", "src", "shared", "theme.css");

if (import.meta.main) {
  const css = await Bun.file(THEME_CSS).text();
  const results = audit(css);
  for (const id of THEME_IDS) {
    console.log(`\n${id}`);
    for (const { check, ratio, required, pass } of results.filter((r) => r.theme === id)) {
      const on = check.on.map((token) => token.slice(2)).join(" + ");
      console.log(
        `  ${pass ? "pass" : "FAIL"}  ${ratio.toFixed(2).padStart(5)} ≥ ${required}  ${check.what} (${check.fg.slice(2)} on ${on})`,
      );
    }
    const closest = toneDistances(css)
      .filter((pair) => pair.theme === id)
      .sort((x, y) => x.distance - y.distance)[0];
    if (closest)
      console.log(
        `  closest status colors: ${closest.a} / ${closest.b}, ΔE ${closest.distance.toFixed(1)}`,
      );
  }
  const failed = results.filter((result) => !result.pass).length;
  console.log(`\n${results.length - failed}/${results.length} pairs pass WCAG 2.2 AA`);
  if (failed) process.exit(1);
}
