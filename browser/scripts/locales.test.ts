import { describe, expect, test } from "bun:test";
import { packLocale } from "./locales";

describe("packLocale", () => {
  test("minifies, and leaves out what is its own translation", () => {
    const source = JSON.stringify(
      {
        Save: "Enregistrer",
        "{n} min": "{n} min",
        Atelier: "Atelier",
        "{n} Activities": { one: "{n} activité", other: "{n} activités" },
      },
      null,
      2,
    );
    expect(packLocale(source)).toBe(
      '{"Save":"Enregistrer","{n} Activities":{"one":"{n} activité","other":"{n} activités"}}',
    );
  });

  test("keeps non-ASCII text as it is", () => {
    expect(packLocale('{\n "Back": "戻る"\n}')).toBe('{"Back":"戻る"}');
  });

  test("refuses a file that isn't an object", () => {
    for (const source of ["[]", "null", '"x"', "{"]) expect(() => packLocale(source)).toThrow();
  });

  test("every locale in src/locales packs, and still holds each string that differs", async () => {
    for await (const file of new Bun.Glob("*.json").scan({ cwd: "src/locales" })) {
      const source = await Bun.file(`src/locales/${file}`).text();
      const packed = JSON.parse(packLocale(source)) as Record<string, unknown>;
      const original = JSON.parse(source) as Record<string, unknown>;
      for (const [english, translation] of Object.entries(original)) {
        if (translation !== english) expect(packed[english]).toEqual(translation);
        else expect(english in packed).toBe(false);
      }
    }
  });
});
