/**
 * The popup and dashboard's words. English is the key itself, so English
 * costs nothing to load; each other language is `locales/<code>.json`, fetched
 * once per view, mapping an English string to its translation. A string with no
 * entry stays English.
 *
 * - `t("Show {name}", { name })` fills `{name}`.
 * - `tn(n, one, other)` picks a plural form; a translation of `other` is an
 *   object with a string per plural category the language has.
 * - `msg("Settings")` marks a string shown elsewhere (a table) with `t`.
 *
 * The completeness check (i18n.test.ts) finds only literals, so a message is
 * never built by joining.
 */

export const LANGUAGES = [
  "en",
  "am",
  "ar",
  "ca",
  "de",
  "el",
  "es",
  "es-419",
  "et",
  "fa",
  "fr",
  "ja",
  "ko",
  "lt",
  "lv",
  "nl",
  "pl",
  "pt-BR",
  "pt-PT",
  "ro",
  "ru",
  "sl",
  "sv",
  "sw",
  "tr",
  "zh",
] as const;
export type Language = (typeof LANGUAGES)[number];
/** `auto` follows the browser's own language. */
export type LanguagePreference = Language | "auto";

declare const PACKAGED_LANGUAGES: string | undefined;

/**
 * The languages the package this code runs in carries dictionaries for, that
 * a view may list and a stored preference may name. A platform runtime's
 * build defines it (build.ts, `PACKAGE_LANGUAGES` in scripts/store.ts);
 * anywhere else, such as the tests or a bundle whose build didn't define it,
 * it's every language.
 */
export const PACKAGED: readonly Language[] =
  typeof PACKAGED_LANGUAGES === "undefined"
    ? LANGUAGES
    : (JSON.parse(PACKAGED_LANGUAGES) as readonly Language[]);

type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>>;
export type Dictionary = Readonly<Record<string, string | PluralForms>>;
type Variables = Readonly<Record<string, string | number>>;

export const LANGUAGE_NAMES: Readonly<Record<Language, string>> = {
  en: "English",
  am: "አማርኛ",
  ar: "العربية",
  ca: "Català",
  de: "Deutsch",
  el: "Ελληνικά",
  es: "Español",
  "es-419": "Español (América Latina)",
  et: "Eesti",
  fa: "فارسی",
  fr: "Français",
  ja: "日本語",
  ko: "한국어",
  lt: "Lietuvių",
  lv: "Latviešu",
  nl: "Nederlands",
  pl: "Polski",
  "pt-BR": "Português (Brasil)",
  "pt-PT": "Português (Portugal)",
  ro: "Română",
  ru: "Русский",
  sl: "Slovenščina",
  sv: "Svenska",
  sw: "Kiswahili",
  tr: "Türkçe",
  zh: "中文",
};

let language: Language = "en";
let dictionary: Dictionary = {};
let numbers = new Intl.NumberFormat("en");
let plurals = new Intl.PluralRules("en");

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

export const msg = (key: string): string => key;

/** Regions whose Spanish is `es-419` on automatic (`419` is Latin America's own code; `ar` is Argentina). */
const SPANISH_LATIN_AMERICA: ReadonlySet<string> = new Set([
  "ar",
  "bo",
  "cl",
  "co",
  "cr",
  "cu",
  "do",
  "419",
  "ec",
  "gt",
  "hn",
  "mx",
  "ni",
  "pa",
  "pe",
  "pr",
  "py",
  "sv",
  "us",
  "uy",
  "ve",
]);

/** The language a preference means, given the browser's own (`en-GB`, `zh-Hans-CN`, …). */
export function resolveLanguage(preference: LanguagePreference, browser: string): Language {
  if (preference !== "auto") return preference;
  const wanted = browser.toLowerCase();
  const [primary, region] = wanted.split(/[-_]/);
  return (
    LANGUAGES.find((candidate) => candidate.toLowerCase() === wanted) ??
    LANGUAGES.find((candidate) => candidate.toLowerCase() === `${primary}-${region}`) ??
    (primary === "es" && region !== undefined && SPANISH_LATIN_AMERICA.has(region)
      ? "es-419"
      : undefined) ??
    LANGUAGES.find((candidate) => candidate.toLowerCase() === primary) ??
    LANGUAGES.find((candidate) => candidate.toLowerCase().startsWith(`${primary}-`)) ??
    "en"
  );
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
