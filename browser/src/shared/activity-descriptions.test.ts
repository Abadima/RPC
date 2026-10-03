import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { setLanguage } from "../core/i18n";
import { loadCatalog } from "./activity-catalog";

const premid = { id: "premid:Example", name: "Example", hosts: ["example.com"], source: "premid" };
const native = { id: "tunes", name: "Tunes", hosts: ["tunes.example"], source: "parousia" };
const files: Record<string, unknown> = {
  "activities/catalog.json": {
    sources: {},
    activities: [
      { ...premid, description: "Example, for tests." },
      { ...native, description: "What's playing." },
    ],
  },
  "activities/descriptions/fr.json": { "premid:Example": "Exemple, pour les tests.", tunes: 7 },
};

const original = { chrome: globalThis.chrome, fetch: globalThis.fetch };

beforeAll(() => {
  globalThis.chrome = {
    runtime: { getURL: (path: string) => `chrome-extension://self/${path}` },
  } as unknown as typeof chrome;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const body = files[String(input).replace("chrome-extension://self/", "")];
    return new Response(body === undefined ? "missing" : JSON.stringify(body), {
      status: body === undefined ? 404 : 200,
    });
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.chrome = original.chrome;
  globalThis.fetch = original.fetch;
});

afterEach(() => setLanguage("en"));

describe("PreMiD Activities' descriptions in the view's language", () => {
  test("replace the English ones in the catalog (the Activity's own page reads them the same way: verify-languages.mjs)", async () => {
    setLanguage("fr");
    const catalog = await loadCatalog();
    expect(catalog.map((info) => info.description)).toEqual([
      "Exemple, pour les tests.",
      // Native Activities have no translation, and a bad entry changes nothing.
      "What's playing.",
    ]);
  });
});
