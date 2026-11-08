import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { LANGUAGES, type Language } from "../src/core/i18n";

/**
 * Storefront text for the Chrome Web Store and Firefox Add-ons, one file per
 * language in `store/listings/`. It is separate from `src/locales/` (the
 * extension's own screens): the stores read their own fields, and neither takes
 * the UI dictionaries. Nothing here reaches a store by itself; the text is
 * entered in the stores' dashboards (see `store/README.md`).
 */

/** One language's storefront text. The description is a list of paragraphs so its shape can be checked. */
export interface Listing {
  summary: string;
  description: readonly string[];
}

/**
 * One language's codes per destination, derived from the lists below (no
 * literal table to keep in step with them):
 *
 * - `chrome`: the Chrome Web Store's spelling (underscores), which is also
 *   the `_locales/` directory name the CWS dashboard lists the language from.
 * - `amo`: AMO's code(s); es-419 is the one language there has three of.
 */
export interface StoreLocale {
  /** Chrome's name for it, which is also the `_locales/` directory its dashboard offers the language from. */
  readonly chrome: string;
  /** Firefox Add-ons codes that receive this text. */
  readonly amo: readonly string[];
}

/** Chrome underscores a regional code and has no bare `zh` (`zh_CN`); everywhere else it's what the language spells. */
const chromeCode = (language: Language): string => {
  switch (language) {
    case "zh":
      return "zh_CN";
    default:
      return language.replaceAll("-", "_");
  }
};

/**
 * AMO normalizes bare `es`, `sv` and `zh` to their regional codes and has no
 * `es-419`, whose text goes to the three Latin American Spanish codes it has.
 * Everything else keeps the language's own name.
 */
const amoCodes = (language: Language): readonly string[] => {
  switch (language) {
    case "en":
      return ["en-US"];
    case "es":
      return ["es-ES"];
    case "sv":
      return ["sv-SE"];
    case "zh":
      return ["zh-CN"];
    case "es-419":
      return ["es-MX", "es-AR", "es-CL"];
    default:
      return [language];
  }
};

export const STORE_LOCALES: Record<Language, StoreLocale> = Object.fromEntries(
  LANGUAGES.map((language) => [
    language,
    { chrome: chromeCode(language), amo: amoCodes(language) },
  ]),
) as Record<Language, StoreLocale>;

/**
 * The four lists a locale code answers to. Two know what a browser takes, in
 * the package's own spelling (`_locales/<code>/`, checked through
 * `browserCode`, Chrome's regional codes are hyphens there); two know what a
 * store's dashboard takes. The store text and the packaged messages each
 * consult their own pair, so a store can hold a language a browser doesn't
 * and the other way round: AMO takes no Amharic yet, and Firefox's own list
 * has no `am` or `sw`, so neither lands in a Firefox package's `_locales/`
 * or dictionary set (see `PACKAGE_LANGUAGES`).
 */

/** Chrome's supported locales: developer.chrome.com/docs/extensions/reference/api/i18n#locales (checked 2026-11-07). */
export const CHROME_LOCALES: ReadonlySet<string> = new Set(
  "af am ar az be bg bn br bs ca cs cy da de de-AT de-CH de-DE el en en-AU en-CA en-GB en-IN en-NZ en-US en-ZA eo es es-419 es-AR es-CL es-CO es-CR es-ES es-HN es-MX es-PE es-US es-UY es-VE et eu fa fi fil fr fr-CA fr-CH fy ga gd gl gn gu ha haw he hi hr hu hy id is it it-CH ja jv ka kk km kn ko ku ky la lb lo lt lv mk ml mn mr ms mt nb ne nl nn pa pl pt-BR pt-PT qu rm ro ru sd si sk sl sq sr sv sw ta te th tr uk ur uz vi zh-CN zh-HK zh-TW zu".split(
    " ",
  ),
);

/** Chrome Web Store's supported locales: developer.chrome.com/docs/webstore/i18n (checked 2026-11-07). */
export const CWS_LOCALES: ReadonlySet<string> = new Set(
  "am ar bg bn ca cs da de el en en_AU en_GB en_US es es_419 et fa fi fil fr gu he hi hr hu id it ja kn ko lt lv ml mr ms nl no pl pt_BR pt_PT ro ru sk sl sr sv sw ta te th tr uk vi zh_CN zh_TW".split(
    " ",
  ),
);

/**
 * Firefox's supported locales: developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Internationalization (checked 2026-11-07). AMO normalizes `es`, `sv` and `zh` to a regional code, and has no `es-419`.
 *
 */
export const FIREFOX_LOCALES: ReadonlySet<string> = new Set(
  "ach af an ar ast az be bg bn bo br brx bs ca ca-valencia cak cs cy da de dsb el en-CA en-GB en-US eo es-AR es-CL es-ES es-MX et eu fa ff fi fr fur fy-NL ga-IE gd gl gn gu-IN he hi-IN hr hsb hu hy-AM ia id is it ja ja-JP-mac ka kab kk km kn ko lij lo lt ltg lv mk ml mr ms my nb-NO ne-NP nl nn-NO oc or pa-IN pl pt-BR pt-PT rm ro ru sat sc sco si sk sl son sq sr sv-SE szl ta te tg th tl tr trs uk ur uz vi wo xh zh-CN zh-TW".split(
    " ",
  ),
);

/**
 * Firefox Add-ons languages, from `AMO_LANGUAGES` in mozilla/addons-server
 * (`olympia/core/languages.py`, checked 2026-11-08). Production settings may
 * trim it; the Developer Hub's own language picker has the last word, and
 * live listings carry `ar`, `ca`, `et`, `lt` and `lv` today. Amharic is left
 * out: no listing of AMO's offers it yet.
 */
export const AMO_LOCALES: ReadonlySet<string> = new Set(
  "ach af an ar ast az be bg bn bo br brx bs ca ca-valencia cak cs cy da de dsb el en-CA en-GB en-US eo es-AR es-CL es-ES es-MX et eu fa ff fi fr fur fy-NL ga-IE gd gl gn gu-IN he hi-IN hr hsb hu hy-AM ia id is it ja ja-JP-mac ka kab kk km kn ko lij lo lt ltg lv mk ml mr ms my nb-NO ne-NP nl nn-NO oc or pa-IN pl pt-BR pt-PT rm ro ru sat sc sco si sk sl son sq sr sv-SE sw szl ta te tg th tl tr trs uk ur uz vi wo xh zh-CN zh-TW".split(
    " ",
  ),
);

/** A `_locales/` code as the browser's own list spells it (`es_419` there is `es-419`). */
export const browserCode = (code: string): string => code.replaceAll("_", "-");

/**
 * What each packaged build bundles: the languages we have that the platform's
 * own list names in one of its spellings. Chromium's list covers every
 * language of ours; Firefox has no Amharic or Swahili, so its package leaves
 * both out, and so do its language pickers (a stored preference for one falls
 * back to `auto`). The userscript may run anywhere, so it carries all.
 */
export type PackageTarget = "chromium" | "firefox" | "userscript";

export const PACKAGE_LANGUAGES: Readonly<Record<PackageTarget, readonly Language[]>> = {
  chromium: LANGUAGES.filter((language) => CHROME_LOCALES.has(browserCode(chromeCode(language)))),
  firefox: LANGUAGES.filter((language) =>
    amoCodes(language).some((code) => FIREFOX_LOCALES.has(code)),
  ),
  userscript: [...LANGUAGES],
};

/** Characters. Chrome: the summary is the manifest `description`. Neither store documents a description limit; 16,000 is the lowest figure reported. */
export const LIMITS = { chromeSummary: 132, amoSummary: 250, description: 16_000 } as const;

/** The message that carries the summary in a package's `_locales/<code>/messages.json`. */
export const SUMMARY_MESSAGE = "extDescription";

/** Paragraphs in a description, as the English source has them. */
const PARAGRAPHS = 8;

export const LISTINGS_DIR = join(import.meta.dir, "..", "store", "listings");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseListing(value: unknown): Listing {
  if (
    !isRecord(value) ||
    typeof value.summary !== "string" ||
    !Array.isArray(value.description) ||
    !value.description.every((paragraph): paragraph is string => typeof paragraph === "string") ||
    Object.keys(value).length !== 2
  ) {
    throw new Error("a listing is { summary: string, description: string[] } and nothing else");
  }
  return { summary: value.summary, description: value.description };
}

export async function loadListings(dir = LISTINGS_DIR): Promise<Record<Language, Listing>> {
  const entries = await Promise.all(
    LANGUAGES.map(async (language) => {
      const file = join(dir, `${language}.json`);
      try {
        return [language, parseListing(await Bun.file(file).json())] as const;
      } catch (error) {
        throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, {
          cause: error,
        });
      }
    }),
  );
  return Object.fromEntries(entries) as Record<Language, Listing>;
}

/** Plain text with blank lines between paragraphs: what both dashboards take (Chrome shows no markup; AMO reads a little Markdown, which this has none of). */
export function descriptionText(listing: Listing): string {
  return listing.description.join("\n\n");
}

/** A package's `_locales/<code>/messages.json`: the summary only, since the name stays the brand and the screens have their own dictionaries. */
export function chromeMessages(listing: Listing): string {
  return JSON.stringify({ [SUMMARY_MESSAGE]: { message: listing.summary } });
}

// Names that stay in Latin script in every language.
const NAMES = /Parousia|Discord|Rich Presence|PreMiD|TypeScript|Inc\./g;
// Technical words that several of the Latin-script languages keep as they are.
const SHARED_TERMS = /open[- ]?source|browser|desktop|websites?|web|status/gi;
const NON_LATIN: ReadonlySet<Language> = new Set(["am", "ar", "el", "fa", "ja", "ko", "ru", "zh"]);
// English words that no other language of the 25 spells the same way.
const ENGLISH_ONLY = /\b(?:the|and|your|with|which|where|that|this|you)\b/i;
const LATIN_WORD = /\p{Script=Latin}{2,}/gu;
const DASHES = /[–—]|--/;
// Markdown on AMO and angle brackets in both stores; none belongs in this text.
const MARKUP = /[*_`<>[\]#|\\]|https?:|www\./;
// Zero-width and bidirectional controls: invisible, and a way to make text read differently from how it is stored.
const INVISIBLE = /[\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/;
const ODD_SPACE = /[\u2000-\u200A\u202F\u205F\u3000\t]| {2}|^ | $/;

function check(problems: string[], ok: boolean, message: string): void {
  if (!ok) problems.push(message);
}

/**
 * A sentence made mostly of words the English source also uses. Real
 * translations peak near 0.3 of their sentence's words (cognates and kept
 * terms); a sentence left in English scores above 0.55.
 */
function englishSentence(text: string, vocabulary: ReadonlySet<string>): string | undefined {
  for (const sentence of text.split(/(?<=[.?!])\s+/)) {
    const words =
      sentence.replace(NAMES, " ").replace(SHARED_TERMS, " ").toLowerCase().match(LATIN_WORD) ?? [];
    if (
      words.length >= 4 &&
      words.filter((word) => vocabulary.has(word)).length / words.length > 0.5
    ) {
      return sentence;
    }
  }
  return undefined;
}

/** What is wrong with one language's listing; an empty list is a pass. */
export function listingProblems(language: Language, listing: Listing, english: Listing): string[] {
  const problems: string[] = [];
  const { summary, description } = listing;
  const text = descriptionText(listing);
  const all = [summary, ...description];

  check(problems, summary.length > 0, "summary is empty");
  check(
    problems,
    summary.length <= LIMITS.chromeSummary,
    `summary is ${summary.length} characters; Chrome allows ${LIMITS.chromeSummary}`,
  );
  check(problems, !summary.includes("\n"), "summary has a line break");
  check(
    problems,
    description.length === PARAGRAPHS,
    `description has ${description.length} paragraphs, not ${PARAGRAPHS}`,
  );
  check(
    problems,
    text.length <= LIMITS.description,
    `description is ${text.length} characters; keeping under ${LIMITS.description}`,
  );
  for (const [index, paragraph] of description.entries()) {
    check(problems, paragraph.length > 20, `paragraph ${index + 1} is empty or a stub`);
    check(problems, !paragraph.includes("\n"), `paragraph ${index + 1} has a line break`);
  }

  for (const piece of all) {
    check(problems, !DASHES.test(piece), `has a dash used as punctuation: ${piece.slice(0, 40)}`);
    check(problems, !MARKUP.test(piece), `has markup or a link: ${piece.slice(0, 40)}`);
    check(problems, !INVISIBLE.test(piece), `has an invisible control: ${piece.slice(0, 40)}`);
    check(problems, !ODD_SPACE.test(piece), `has an odd space: ${piece.slice(0, 40)}`);
  }

  // The claims every translation has to keep, found by the names that anchor them.
  check(problems, /Discord/.test(summary), "summary doesn't name Discord");
  check(
    problems,
    /Rich Presence|リッチプレゼンス/.test(summary),
    "summary doesn't name Rich Presence",
  );
  // The stem, since Polish declines the name and Slovenian restates the sentence around it.
  const naming = description.filter((paragraph) => paragraph.includes("Parousi")).length;
  check(
    problems,
    naming >= 5,
    `Parousia is named in ${naming} paragraphs; the source names it in 6`,
  );
  check(problems, description[3]?.includes("PreMiD") === true, "paragraph 4 doesn't name PreMiD");
  check(
    problems,
    description[4]?.includes("TypeScript") === true,
    "paragraph 5 doesn't name TypeScript",
  );
  check(
    problems,
    description[7]?.includes("Discord Inc.") === true,
    "the last paragraph doesn't name Discord Inc.",
  );
  check(problems, text.includes("Rich Presence"), "description doesn't name Rich Presence");
  check(problems, (text.match(/Discord/g) ?? []).length <= 9, "Discord is named more than 9 times");
  check(problems, (text.match(/Rich Presence/g) ?? []).length <= 5, "Rich Presence is repeated");

  if (language !== "en") {
    check(problems, summary !== english.summary, "summary is still English");
    for (const [index, paragraph] of description.entries()) {
      check(
        problems,
        paragraph !== english.description[index],
        `paragraph ${index + 1} is still English`,
      );
    }
    const rest = all.join(" ").replace(NAMES, " ");
    if (NON_LATIN.has(language)) {
      const left = rest.match(/[A-Za-z]{2,}/g) ?? [];
      check(
        problems,
        left.length === 0,
        `Latin words left in a ${language} text: ${left.join(", ")}`,
      );
    } else {
      const leftover = ENGLISH_ONLY.exec(rest);
      check(problems, leftover === null, `English left in the text: ${leftover?.[0]}`);
      const vocabulary = new Set(
        [english.summary, ...english.description].flatMap(
          (piece) => piece.replace(NAMES, " ").toLowerCase().match(LATIN_WORD) ?? [],
        ),
      );
      const sentence = englishSentence(all.join(" "), vocabulary);
      check(problems, sentence === undefined, `English sentence left in the text: ${sentence}`);
    }
  }
  return problems;
}

/** The stem of a UI term, short enough to survive the language's endings. */
function stem(term: string): string {
  const letters = [...term.toLowerCase()];
  return letters.slice(0, Math.max(2, Math.ceil(letters.length * 0.6))).join("");
}

/**
 * Whether the listing uses the words the extension's own screens use for the
 * Activity and the extension, so the store text and the product read alike.
 * `dictionary` is the language's `src/locales/<code>.json`.
 */
export function termProblems(listing: Listing, dictionary: Record<string, unknown>): string[] {
  const text = descriptionText(listing).toLowerCase();
  const terms = (...keys: string[]): string[] =>
    keys.flatMap((key) => {
      const term = dictionary[key];
      return typeof term === "string" ? [term] : [];
    });
  const problems: string[] = [];
  for (const [name, keys] of [
    ["Activity", ["Activity", "Activities"]],
    ["Extension", ["Extension"]],
  ] as const) {
    const found = terms(...keys);
    if (found.length === 0) problems.push(`the screens have no word for ${name}`);
    else if (!found.some((term) => text.includes(stem(term)))) {
      problems.push(
        `the description doesn't use the screens' word for ${name} (${found.join(", ")})`,
      );
    }
  }
  return problems;
}

/** Everything the dashboards take, written to `outDir`; the stores are not contacted. */
export async function exportStore(
  listings: Record<Language, Listing>,
  outDir: string,
): Promise<string[]> {
  await rm(outDir, { recursive: true, force: true });
  const written: string[] = [];
  const write = async (path: string, content: string): Promise<void> => {
    await mkdir(join(path, ".."), { recursive: true });
    await Bun.write(path, content);
    written.push(path);
  };
  const heldBack: string[] = [];

  const patch = {
    summary: {} as Record<string, string>,
    description: {} as Record<string, string>,
  };
  for (const language of LANGUAGES) {
    const { chrome, amo } = STORE_LOCALES[language];
    const listing = listings[language];
    // Each store takes a language under its own list; the same text can reach
    // one store and not the other.
    if (CWS_LOCALES.has(chrome)) {
      await write(join(outDir, "chrome", `${chrome}.txt`), `${descriptionText(listing)}\n`);
    }
    for (const code of amo) {
      if (!AMO_LOCALES.has(code)) {
        heldBack.push(code);
        continue;
      }
      await write(join(outDir, "firefox", code, "summary.txt"), `${listing.summary}\n`);
      await write(
        join(outDir, "firefox", code, "description.txt"),
        `${descriptionText(listing)}\n`,
      );
      // The English text is already live on AMO; the request carries only the new languages.
      if (language !== "en") {
        patch.summary[code] = listing.summary;
        patch.description[code] = descriptionText(listing);
      }
    }
  }
  if (heldBack.length > 0) console.log(`[store] AMO doesn't take: ${heldBack.join(", ")}`);
  await write(join(outDir, "firefox", "listing.json"), `${JSON.stringify(patch, null, 2)}\n`);
  return written;
}

async function main(): Promise<void> {
  const [command = "check", target = join("dist", "store")] = process.argv.slice(2);
  const listings = await loadListings();
  if (command === "export") {
    const written = await exportStore(listings, target);
    console.log(`[store] wrote ${written.length} files to ${target}`);
    return;
  }
  if (command !== "check") throw new Error(`unknown command "${command}" (check, export [dir])`);

  let failed = false;
  for (const language of LANGUAGES) {
    const listing = listings[language];
    const { chrome, amo } = STORE_LOCALES[language];
    const dictionary =
      language === "en"
        ? {}
        : ((await Bun.file(
            join(import.meta.dir, "..", "src", "locales", `${language}.json`),
          ).json()) as Record<string, unknown>);
    const problems = [
      ...listingProblems(language, listing, listings.en),
      ...(language === "en" ? [] : termProblems(listing, dictionary)),
    ];
    console.log(
      `${language.padEnd(7)} chrome ${chrome.padEnd(6)} amo ${amo.join(",").padEnd(16)} summary ${String(listing.summary.length).padStart(3)}/${LIMITS.chromeSummary}  description ${String(descriptionText(listing).length).padStart(5)}  ${problems.length === 0 ? "ok" : "PROBLEMS"}`,
    );
    for (const problem of problems) console.log(`    ${problem}`);
    failed ||= problems.length > 0;
  }
  if (failed) process.exitCode = 1;
}

if (import.meta.main) await main();
