import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANGUAGES, type Language } from "../src/core/i18n";
import {
  AMO_LOCALES,
  CHROME_LOCALES,
  CWS_LOCALES,
  LIMITS,
  PACKAGE_LANGUAGES,
  STORE_LOCALES,
  SUMMARY_MESSAGE,
  browserCode,
  chromeMessages,
  descriptionText,
  exportStore,
  listingProblems,
  loadListings,
  parseListing,
  termProblems,
  type Listing,
} from "./store";

const listings = await loadListings();
const english = listings.en;
const TRANSLATED = LANGUAGES.filter((language) => language !== "en");

const dictionary = async (language: Language): Promise<Record<string, unknown>> =>
  (await Bun.file(
    join(import.meta.dir, "..", "src", "locales", `${language}.json`),
  ).json()) as Record<string, unknown>;

describe("the listings", () => {
  test("cover the extension's languages, no more and no fewer", async () => {
    const files = (await readdir(join(import.meta.dir, "..", "store", "listings"))).sort();
    expect(files).toEqual(LANGUAGES.map((language) => `${language}.json`).sort());
    expect(Object.keys(STORE_LOCALES).sort()).toEqual([...LANGUAGES].sort());
  });

  test("keep the English summary the manifests carry", async () => {
    for (const target of ["chromium", "firefox"]) {
      const manifest = (await Bun.file(
        join(import.meta.dir, "..", "manifests", `${target}.json`),
      ).json()) as {
        description: string;
      };
      expect(manifest.description).toBe(english.summary);
    }
  });
});

describe("the store locale codes", () => {
  test("are ones Chrome lists, in the browser package as well as its store", () => {
    for (const language of LANGUAGES) {
      const code = STORE_LOCALES[language].chrome;
      // The `_locales/` code, underscores and all, is the store's; the
      // browser's own list spells the same code with hyphens.
      expect(CWS_LOCALES.has(code)).toBe(true);
      expect(CHROME_LOCALES.has(browserCode(code))).toBe(true);
    }
    const chrome = LANGUAGES.map((language) => STORE_LOCALES[language].chrome);
    expect(new Set(chrome).size).toBe(chrome.length);
  });

  test("are unique across languages", () => {
    const amo = LANGUAGES.flatMap((language) => STORE_LOCALES[language].amo);
    expect(new Set(amo).size).toBe(amo.length);
    // What AMO holds is its own data (`AMO_LOCALES`); the mapping keeps every
    // language's code even where that list has none, so a store that grows
    // its list picks the language up on the next push.
  });

  test("follow each store's own spelling of the languages that differ", () => {
    expect(STORE_LOCALES["es-419"]).toEqual({ chrome: "es_419", amo: ["es-MX", "es-AR", "es-CL"] });
    expect(STORE_LOCALES["pt-BR"].chrome).toBe("pt_BR");
    expect(STORE_LOCALES.zh).toEqual({ chrome: "zh_CN", amo: ["zh-CN"] });
    expect(STORE_LOCALES.es.amo).toEqual(["es-ES"]);
    expect(STORE_LOCALES.sv.amo).toEqual(["sv-SE"]);
  });
});

describe.each(TRANSLATED)("%s", (language) => {
  test("keeps to both stores' limits and the text's rules", () => {
    expect(listingProblems(language, listings[language], english)).toEqual([]);
  });

  test("uses the words the extension's screens use for Activity and Extension", async () => {
    expect(termProblems(listings[language], await dictionary(language))).toEqual([]);
  });
});

test("the English source passes the same rules", () => {
  expect(listingProblems("en", english, english)).toEqual([]);
});

describe("the packages' languages", () => {
  test("Chromium takes every language; Firefox takes what Firefox itself names", () => {
    expect(PACKAGE_LANGUAGES.chromium).toEqual([...LANGUAGES]);
    // Chromium's own list names every language of ours; Firefox's names none
    // of Amharic and Swahili, so its package leaves both out: its pickers
    // (through `PACKAGED`) say so, and a language may reach one package and
    // not the other.
    expect(PACKAGE_LANGUAGES.firefox).toEqual(
      LANGUAGES.filter((language) => language !== "am" && language !== "sw"),
    );
    expect(PACKAGE_LANGUAGES.userscript).toEqual([...LANGUAGES]);
  });
});

describe("the checks catch what they are for", () => {
  const french = listings.fr;
  const withParagraph = (index: number, text: string): Listing => ({
    summary: french.summary,
    description: french.description.map((paragraph, i) => (i === index ? text : paragraph)),
  });

  test("a summary over Chrome's 132 characters", () => {
    const long = {
      ...french,
      summary: `Discord Rich Presence ${"x".repeat(LIMITS.chromeSummary)}`,
    };
    expect(listingProblems("fr", long, english).join()).toContain("Chrome allows 132");
  });

  test("a paragraph left in English, or only partly translated", () => {
    expect(
      listingProblems("fr", withParagraph(1, english.description[1] ?? ""), english).join(),
    ).toContain("still English");
    const mixed = withParagraph(5, `${french.description[5] ?? ""} It does not use analytics.`);
    expect(listingProblems("fr", mixed, english).join()).toContain("English sentence left");
    const stopwords = withParagraph(5, `${french.description[5] ?? ""} Install it for free.`);
    expect(listingProblems("fr", stopwords, english).join()).toContain("English");
  });

  test("Latin words left inside a text in another script", () => {
    const text = `${listings.ja.description[1] ?? ""} and more`;
    const broken: Listing = {
      ...listings.ja,
      description: listings.ja.description.map((p, i) => (i === 1 ? text : p)),
    };
    expect(listingProblems("ja", broken, english).join()).toContain("Latin words left");
  });

  test("a dash used as punctuation, markup, a link, and invisible controls", () => {
    expect(
      listingProblems(
        "fr",
        withParagraph(2, `${french.description[2] ?? ""} — oui`),
        english,
      ).join(),
    ).toContain("dash");
    expect(
      listingProblems(
        "fr",
        withParagraph(2, `${french.description[2] ?? ""} **gras**`),
        english,
      ).join(),
    ).toContain("markup");
    expect(
      listingProblems(
        "fr",
        withParagraph(2, `${french.description[2] ?? ""} https://x.test`),
        english,
      ).join(),
    ).toContain("link");
    expect(
      listingProblems("fr", withParagraph(2, `${french.description[2] ?? ""}‮`), english).join(),
    ).toContain("invisible");
  });

  test("a lost claim: the disclaimer, a name, a paragraph", () => {
    expect(
      listingProblems(
        "fr",
        withParagraph(7, "Parousia est un projet indépendant et open source."),
        english,
      ).join(),
    ).toContain("Discord Inc.");
    expect(
      listingProblems(
        "fr",
        withParagraph(3, "Parousia propose son propre écosystème d’activités."),
        english,
      ).join(),
    ).toContain("PreMiD");
    const short: Listing = { ...french, description: french.description.slice(0, 7) };
    expect(listingProblems("fr", short, english).join()).toContain("7 paragraphs");
  });

  test("a word that drifted from the screens' term", async () => {
    const drifted: Listing = {
      summary: french.summary,
      description: french.description.map(
        () => "Nous utilisons des modules pour prendre en charge les sites.",
      ),
    };
    expect(termProblems(drifted, await dictionary("fr")).join()).toContain("Activity");
    expect(termProblems(french, await dictionary("fr"))).toEqual([]);
  });
});

describe("the files the dashboards take", () => {
  test("a listing is a summary and paragraphs, and nothing else", () => {
    expect(parseListing({ summary: "a", description: ["b"] })).toEqual({
      summary: "a",
      description: ["b"],
    });
    for (const bad of [
      null,
      [],
      {},
      { summary: "a" },
      { summary: 1, description: [] },
      { summary: "a", description: [1] },
      { summary: "a", description: [], extra: 1 },
    ]) {
      expect(() => parseListing(bad)).toThrow();
    }
  });

  test("the package carries the summary under the name the manifest asks for", () => {
    expect(JSON.parse(chromeMessages(listings.de))).toEqual({
      [SUMMARY_MESSAGE]: { message: listings.de.summary },
    });
    expect(chromeMessages(listings.de)).toBe(
      JSON.stringify(JSON.parse(chromeMessages(listings.de))),
    );
  });

  test("export writes each store's files, and a Firefox request without the English already live", async () => {
    const out = await mkdtemp(join(tmpdir(), "parousia-store-"));
    try {
      await exportStore(listings, out);
      expect((await readdir(join(out, "chrome"))).sort()).toEqual(
        LANGUAGES.map((language) => `${STORE_LOCALES[language].chrome}.txt`).sort(),
      );
      expect(await Bun.file(join(out, "chrome", "pt_BR.txt")).text()).toBe(
        `${descriptionText(listings["pt-BR"])}\n`,
      );

      const request = (await Bun.file(join(out, "firefox", "listing.json")).json()) as {
        summary: Record<string, string>;
        description: Record<string, string>;
      };
      const codes = TRANSLATED.flatMap((language) => STORE_LOCALES[language].amo)
        .filter((code) => AMO_LOCALES.has(code))
        .sort();
      expect(Object.keys(request.summary).sort()).toEqual(codes);
      expect(Object.keys(request.description).sort()).toEqual(codes);
      // Each code sent answers to at least one language of ours, and the
      // English already live stays out (it is patched separately above).
      expect(
        codes.every((code) => LANGUAGES.some((l) => STORE_LOCALES[l].amo.includes(code))),
      ).toBe(true);
      expect(codes.includes("en-US")).toBe(false);
      expect(request.summary["en-US"]).toBeUndefined();
      expect(request.summary["es-AR"]).toBe(listings["es-419"].summary);
      expect(request.description["zh-CN"]).toBe(descriptionText(listings.zh));
      expect(
        (await readdir(join(out, "firefox"))).filter((name) => name !== "listing.json").sort(),
      ).toEqual(["en-US"].concat(codes).sort());
    } finally {
      await rm(out, { recursive: true, force: true });
    }
  });
});
