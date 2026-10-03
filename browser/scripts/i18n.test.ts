import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LANGUAGES } from "../src/core/i18n";
import { SAME_IN_EVERY_LANGUAGE, collectKeys, pageStrings } from "./i18n-keys";

const locales = join(import.meta.dir, "..", "src", "locales");
const keys = await collectKeys();
const TRANSLATED = LANGUAGES.filter((language) => language !== "en");

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "").sort();

async function read(language: string): Promise<Record<string, unknown>> {
  return (await Bun.file(join(locales, `${language}.json`)).json()) as Record<string, unknown>;
}

describe("finding the strings", () => {
  test("a page's fixed text is each run between tags, plus its labels", () => {
    expect(
      pageStrings(`<!-- gone --><nav aria-label="Dashboard"><a href="#x" title="Open
        dashboard"><span data-icon="a"></span>Over
        view</a><p>Settings &gt; Platforms</p><script>var x = "no"</script>1 ›</nav>`),
    ).toEqual(["Over view", "Settings > Platforms", "Dashboard", "Open dashboard"]);
  });

  test("the code and the pages hold the strings the dictionaries are checked against", () => {
    expect(keys.strings.size).toBeGreaterThan(200);
    expect(keys.strings.has("Retry Connection")).toBe(true);
    expect(keys.strings.has("Settings")).toBe(true);
    expect(keys.plurals.has("{n} Activities")).toBe(true);
    // Written with `tn`, so they're plural forms, not plain strings.
    expect(keys.strings.has("{n} Activities")).toBe(false);
  });
});

describe.each(TRANSLATED)("%s", (language) => {
  test("has every string, once, and nothing the code no longer uses", async () => {
    const dictionary = await read(language);
    const wanted = [...keys.strings, ...keys.plurals].filter(
      (key) => !SAME_IN_EVERY_LANGUAGE.has(key),
    );
    expect(wanted.filter((key) => !(key in dictionary))).toEqual([]);
    const known = new Set([...keys.strings, ...keys.plurals]);
    expect(Object.keys(dictionary).filter((key) => !known.has(key))).toEqual([]);
  });

  test("fills the same {names} as the English, in every plural form", async () => {
    const dictionary = await read(language);
    for (const [key, entry] of Object.entries(dictionary)) {
      const forms = typeof entry === "string" ? [entry] : Object.values(entry as object);
      for (const form of forms) {
        expect(typeof form).toBe("string");
        expect(placeholders(String(form))).toEqual(placeholders(key));
      }
    }
  });

  test("gives each plural string a form for every plural category the language has", async () => {
    const dictionary = await read(language);
    const categories = new Intl.PluralRules(language).resolvedOptions().pluralCategories;
    for (const key of keys.plurals) {
      const entry = dictionary[key];
      if (categories.length === 1) {
        expect(
          typeof entry === "string" || typeof (entry as { other?: unknown }).other === "string",
        ).toBe(true);
        continue;
      }
      expect(Object.keys(entry as object).sort()).toEqual([...categories].sort());
    }
    for (const key of keys.strings) expect(typeof dictionary[key] === "object").toBe(false);
  });

  test("puts the clock in {time} elapsed exactly once", async () => {
    const entry = (await read(language))["{time} elapsed"];
    expect(String(entry).split("{time}")).toHaveLength(2);
  });
});
