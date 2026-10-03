/**
 * The popup and dashboard's words. English is the key itself, so the code
 * reads as it always did and English costs nothing to load; every other
 * language is `locales/<code>.json`, fetched once when a view opens, mapping
 * an English string to its translation. A string with no entry stays English.
 *
 * - `t("Show {name}", { name })` fills `{name}`.
 * - `tn(n, "{n} Activity", "{n} Activities")` picks the form for `n`: English
 *   by itself, and in other languages the entry for the plural form, which is
 *   an object with a string for each plural category the language has (`one`,
 *   `few`, `many`, `other`).
 * - `msg("Settings")` marks a string that's defined away from where it's
 *   shown (a table); show it with `t(…)`.
 *
 * Only strings written as literals are found by the check that every language
 * has every string (i18n.test.ts), so a message is never built by joining.
 */

/** What the popup and dashboard can be shown in; each but English has `locales/<code>.json`. */
export const LANGUAGES = ["en", "de", "fr", "ja", "ro", "ru", "sv", "zh"] as const;
export type Language = (typeof LANGUAGES)[number];
/** `auto` follows the browser's own language. */
export type LanguagePreference = Language | "auto";

type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>>;
export type Dictionary = Readonly<Record<string, string | PluralForms>>;
type Variables = Readonly<Record<string, string | number>>;

export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  en: "English",
  de: "Deutsch",
  fr: "Français",
  ja: "日本語",
  ro: "Română",
  ru: "Русский",
  sv: "Svenska",
  zh: "中文",
};

let language: Language = "en";
let dictionary: Dictionary = {};
let numbers = new Intl.NumberFormat("en");
let plurals = new Intl.PluralRules("en");

/** Switches to `next`, whose strings are `strings` (none for English). */
export function setLanguage(next: Language, strings: Dictionary = {}): void {
  language = next;
  dictionary = strings;
  numbers = new Intl.NumberFormat(next);
  plurals = new Intl.PluralRules(next);
}

export const currentLanguage = (): Language => language;

export const formatNumber = (value: number): string => numbers.format(value);

function fill(template: string, variables?: Variables): string {
  if (!variables) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = Object.hasOwn(variables, name) ? variables[name] : undefined;
    return value === undefined ? match : typeof value === "number" ? formatNumber(value) : value;
  });
}

export function t(key: string, variables?: Variables): string {
  const entry = dictionary[key];
  return fill(typeof entry === "string" ? entry : key, variables);
}

export function tn(count: number, one: string, other: string, variables?: Variables): string {
  const entry = dictionary[other];
  const template =
    typeof entry === "string"
      ? entry
      : entry
        ? (entry[plurals.select(count)] ?? entry.other ?? other)
        : count === 1
          ? one
          : other;
  return fill(template, { n: count, ...variables });
}

/** Marks `key` for translation where it's defined; the caller shows it with `t`. */
export const msg = (key: string): string => key;

/** The language a preference means, given the browser's own (`en-GB`, `zh-Hans-CN`, …). */
export function resolveLanguage(preference: LanguagePreference, browser: string): Language {
  if (preference !== "auto") return preference;
  const primary = browser.toLowerCase().split(/[-_]/)[0];
  return LANGUAGES.find((candidate) => candidate === primary) ?? "en";
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const PLURAL_CATEGORIES: readonly Intl.LDMLPluralRule[] = [
  "zero",
  "one",
  "two",
  "few",
  "many",
  "other",
];

/** What's in a locale file that's a string or a set of plural forms; anything else is skipped. */
export function parseDictionary(value: unknown): Dictionary {
  const dictionary: Record<string, string | PluralForms> = {};
  if (!isObject(value)) return dictionary;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      dictionary[key] = entry;
    } else if (isObject(entry)) {
      const forms: PluralForms = {};
      for (const category of PLURAL_CATEGORIES) {
        const form = entry[category];
        if (typeof form === "string") forms[category] = form;
      }
      dictionary[key] = forms;
    }
  }
  return dictionary;
}

export async function fetchDictionary(target: Language): Promise<Dictionary> {
  try {
    const response = await fetch(chrome.runtime.getURL(`locales/${target}.json`));
    return response.ok ? parseDictionary(await response.json()) : {};
  } catch {
    return {};
  }
}

const SPACE = /\s+/g;
const TRANSLATED_ATTRIBUTES = ["aria-label", "title", "placeholder"] as const;
const ATTRIBUTE_SELECTOR = TRANSLATED_ATTRIBUTES.map((name) => `[${name}]`).join(",");

/**
 * Translates the fixed text of a page or a cloned template: each text node
 * whose words (spaces collapsed) are a string with a translation, and the
 * `aria-label`, `title`, and `placeholder` of each element. A page written
 * in English needs no markup for it.
 */
export function translateTree(root: Element | Document): void {
  if (language === "en") return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const raw = node.nodeValue ?? "";
    const key = raw.replace(SPACE, " ").trim();
    const entry = key ? dictionary[key] : undefined;
    if (typeof entry !== "string") continue;
    node.nodeValue = `${/^\s*/.exec(raw)?.[0] ?? ""}${entry}${/\s*$/.exec(raw)?.[0] ?? ""}`;
  }
  const scope = root instanceof Document ? root.documentElement : root;
  const elements = [...scope.querySelectorAll(ATTRIBUTE_SELECTOR)];
  if (scope.matches(ATTRIBUTE_SELECTOR)) elements.push(scope);
  for (const element of elements) {
    for (const name of TRANSLATED_ATTRIBUTES) {
      const entry = dictionary[element.getAttribute(name)?.replace(SPACE, " ").trim() ?? ""];
      if (typeof entry === "string") element.setAttribute(name, entry);
    }
  }
}
