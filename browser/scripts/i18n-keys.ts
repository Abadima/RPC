import { join } from "node:path";

/**
 * The strings the popup and dashboard show, found where they're written (see
 * src/core/i18n.ts for how they're marked), so the check that every language
 * has every string can't drift from the code.
 */

const SOURCE = join(import.meta.dir, "..", "src");
const PAGES = ["popup/popup.html", "fullscreen/fullscreen.html"] as const;

/** Names of products and projects: the same in every language, so a language needn't list them. */
export const SAME_IN_EVERY_LANGUAGE: ReadonlySet<string> = new Set([
  "PAROUSIA",
  "Parousia",
  "Parousia Desktop",
  "PreMiD",
  "Discord-RPC-Extension",
  "MAL-Sync",
  "Apache License 2.0",
  "Atelier",
  "Botanique",
  "Monolith",
]);

export interface Keys {
  /** Strings with one form. */
  strings: Set<string>;
  /** Strings written with `tn`, by their plural form. */
  plurals: Set<string>;
}

const LITERAL = String.raw`("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\`[^\`$\\]*\`)`;
const MARKED = new RegExp(String.raw`(?<![\w.])(?:t|msg)\(\s*${LITERAL}`, "g");
const PLURAL = new RegExp(String.raw`(?<![\w.])tn\(\s*[^,()]+,\s*${LITERAL}\s*,\s*${LITERAL}`, "g");

const ESCAPES: Record<string, string> = { n: "\n", t: "\t" };

/** A string literal's value: its text between the quotes, with the backslash escapes undone. */
function value(literal: string): string {
  return literal.slice(1, -1).replaceAll(/\\(.)/g, (_, char: string) => ESCAPES[char] ?? char);
}

const ENTITIES: Record<string, string> = { gt: ">", lt: "<", amp: "&", quot: '"', "#39": "'" };
const decode = (text: string): string =>
  text.replaceAll(/&(gt|lt|amp|quot|#39);/g, (_, name: string) => ENTITIES[name] ?? "");

const words = (text: string): string => text.replaceAll(/\s+/g, " ").trim();

/** What isn't a page's own text: comments, script and style blocks, and tags, found in one pass. */
const MARKUP = /<!--[\s\S]*?-->|<(?:script|style)\b[\s\S]*?<\/(?:script|style)>|<[^>]*>/g;
const LABELLED = /\s(?:aria-label|title|placeholder)="([^"]*)"/g;

/**
 * Fixed text in a page: each run of text between tags, and the attributes a
 * language may translate. The page is split at its markup, never rewritten,
 * so nothing is left behind that could form markup again.
 */
export function pageStrings(html: string): string[] {
  const found: string[] = [];
  for (const segment of html.split(MARKUP)) {
    const text = words(decode(segment));
    if (/\p{L}/u.test(text)) found.push(text);
  }
  for (const [markup] of html.matchAll(MARKUP)) {
    // Comments, scripts, and styles hold no text a person reads.
    if (markup.startsWith("<!--") || /^<(?:script|style)\b/.test(markup)) continue;
    for (const label of markup.matchAll(LABELLED)) found.push(words(decode(label[1] ?? "")));
  }
  return found;
}

export async function collectKeys(): Promise<Keys> {
  const keys: Keys = { strings: new Set(), plurals: new Set() };
  for await (const file of new Bun.Glob("**/*.ts").scan({ cwd: SOURCE })) {
    // i18n.ts explains the calls with examples; tests and typings hold no UI text.
    if (file === "core/i18n.ts" || file.endsWith(".test.ts") || file.endsWith(".d.ts")) continue;
    const source = await Bun.file(join(SOURCE, file)).text();
    for (const match of source.matchAll(MARKED)) keys.strings.add(value(match[1] ?? ""));
    for (const match of source.matchAll(PLURAL)) keys.plurals.add(value(match[2] ?? ""));
  }
  for (const page of PAGES) {
    for (const text of pageStrings(await Bun.file(join(SOURCE, page)).text()))
      keys.strings.add(text);
  }
  return keys;
}
