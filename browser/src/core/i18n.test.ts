import { afterEach, describe, expect, test } from "bun:test";
import { formatNumber, msg, parseDictionary, resolveLanguage, setLanguage, t, tn } from "./i18n";

afterEach(() => setLanguage("en"));

describe("English, which is the strings themselves", () => {
  test("t returns its key and fills what's in braces", () => {
    expect(t("Settings")).toBe("Settings");
    expect(t("Show {name}", { name: "YouTube" })).toBe("Show YouTube");
    expect(t("Show {name}")).toBe("Show {name}");
    expect(t("{a} {b}", { a: "{b}", b: "x" })).toBe("{b} x");
    expect(t("{constructor}", { name: "x" })).toBe("{constructor}");
  });

  test("tn picks the singular for one and the plural for everything else", () => {
    expect(tn(1, "{n} Activity", "{n} Activities")).toBe("1 Activity");
    expect(tn(0, "{n} Activity", "{n} Activities")).toBe("0 Activities");
    expect(tn(1234, "{n} Activity", "{n} Activities")).toBe("1,234 Activities");
    expect(tn(2, "Enabled {count}. {n} left.", "Enabled {count}. {n} left.", { count: "x" })).toBe(
      "Enabled x. 2 left.",
    );
  });

  test("msg marks a string and changes nothing", () => {
    expect(msg("General")).toBe("General");
  });
});

describe("another language", () => {
  test("a string with an entry is translated, and one without stays English", () => {
    setLanguage("fr", { Save: "Enregistrer", "Show {name}": "Afficher {name}" });
    expect(t("Save")).toBe("Enregistrer");
    expect(t("Show {name}", { name: "YouTube" })).toBe("Afficher YouTube");
    expect(t("Cancel")).toBe("Cancel");
  });

  test("tn uses the language's own plural forms, Russian's three included", () => {
    setLanguage("ru", {
      "{n} Activities": {
        one: "{n} активность",
        few: "{n} активности",
        many: "{n} активностей",
        other: "{n} активности",
      },
    });
    const text = (n: number): string => tn(n, "{n} Activity", "{n} Activities");
    expect(text(1)).toBe("1 активность");
    expect(text(21)).toBe("21 активность");
    expect(text(3)).toBe("3 активности");
    expect(text(5)).toBe("5 активностей");
    expect(text(11)).toBe("11 активностей");
    expect(formatNumber(1234.5)).toBe(new Intl.NumberFormat("ru").format(1234.5));
  });

  test("a language with one plural form takes a plain string", () => {
    setLanguage("ja", { "{n} Activities": "{n} 件のアクティビティ" });
    expect(tn(1, "{n} Activity", "{n} Activities")).toBe("1 件のアクティビティ");
    expect(tn(5, "{n} Activity", "{n} Activities")).toBe("5 件のアクティビティ");
  });

  test("a plural entry missing the form wanted falls back to `other`, then to English", () => {
    setLanguage("fr", { "{n} Activities": { other: "{n} activités" } });
    expect(tn(1, "{n} Activity", "{n} Activities")).toBe("1 activités");
    setLanguage("fr", { "{n} Activities": {} });
    expect(tn(3, "{n} Activity", "{n} Activities")).toBe("3 Activities");
    setLanguage("fr", { Save: { other: "x" } });
    expect(t("Save")).toBe("Save");
  });
});

describe("the language to use", () => {
  test("a chosen language wins; automatic follows the browser's, region before language", () => {
    expect(resolveLanguage("ja", "fr-FR")).toBe("ja");
    expect(resolveLanguage("auto", "fr-FR")).toBe("fr");
    expect(resolveLanguage("auto", "zh-Hans-CN")).toBe("zh");
    expect(resolveLanguage("auto", "ru")).toBe("ru");
    expect(resolveLanguage("auto", "en_GB")).toBe("en");
    expect(resolveLanguage("auto", "de-DE")).toBe("de");
    expect(resolveLanguage("auto", "de_AT")).toBe("de");
    expect(resolveLanguage("auto", "ro-RO")).toBe("ro");
    expect(resolveLanguage("auto", "sv_FI")).toBe("sv");
    expect(resolveLanguage("auto", "es-ES")).toBe("es");
    expect(resolveLanguage("auto", "es-MX")).toBe("es-419");
    expect(resolveLanguage("auto", "es-US")).toBe("es-419");
    // Portuguese has no neutral variant: the browser's region, then
    // Brazilian, which Unicode's likely subtags give bare `pt`.
    expect(resolveLanguage("auto", "pt-BR")).toBe("pt-BR");
    expect(resolveLanguage("auto", "pt_PT")).toBe("pt-PT");
    expect(resolveLanguage("auto", "pt-AO")).toBe("pt-BR");
    expect(resolveLanguage("auto", "")).toBe("en");
  });

  test("the newer languages resolve from what Chromium (`tr-TR`) and Firefox (`tr`) report", () => {
    for (const [browser, language] of [
      ["am-ET", "am"],
      ["ca-ES-valencia", "ca"],
      ["et", "et"],
      ["fa-IR", "fa"],
      ["lt_LT", "lt"],
      ["lv", "lv"],
      ["pl", "pl"],
      ["pl-PL", "pl"],
      ["pl_PL", "pl"],
      ["sl-SI", "sl"],
      ["sw-KE", "sw"],
      ["tr-TR", "tr"],
    ] as const) {
      expect(resolveLanguage("auto", browser)).toBe(language);
    }
  });
});

describe("parseDictionary", () => {
  test("keeps strings and plural forms, and drops anything else", () => {
    expect(
      parseDictionary({
        a: "x",
        b: { one: "1", other: "n", many: 3, bogus: "y" },
        c: 4,
        d: null,
        e: ["x"],
      }),
    ).toEqual({ a: "x", b: { one: "1", other: "n" } });
    expect(parseDictionary("nope")).toEqual({});
    expect(parseDictionary(null)).toEqual({});
    expect(parseDictionary([])).toEqual({});
  });
});
