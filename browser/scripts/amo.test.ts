import { describe, expect, test } from "bun:test";
import { AMO_LOCALES, LIMITS, STORE_LOCALES, loadListings } from "./store";
import { LANGUAGES } from "../src/core/i18n";
import { amoListings, amoPatch, blockedListings, loadAmoConfig, signJwt } from "./amo";

const listings = await loadListings();

describe("the AMO patch", () => {
  test("carries every translated language under its AMO codes, and nothing else", () => {
    const patch = amoPatch(listings);
    expect(Object.keys(patch.summary).sort()).toEqual(Object.keys(patch.description).sort());
    expect(patch.summary["en-US"]).toBeUndefined();
    expect(Object.keys(patch.summary)).toEqual(amoListings(listings).map((one) => one.code));
  });

  test("keeps every code a real AMO language, and every summary inside AMO's limit", () => {
    for (const { code, summary, description } of amoListings(listings)) {
      expect(AMO_LOCALES.has(code)).toBe(true);
      expect(summary.length).toBeLessThanOrEqual(LIMITS.amoSummary);
      expect(description.length).toBeGreaterThan(0);
    }
  });

  test("maps the languages whose AMO codes differ", () => {
    const patch = amoPatch(listings);
    expect(patch.summary["es-MX"] === patch.summary["es-AR"]).toBe(true);
    expect(patch.summary["sv-SE"]).toBeDefined();
    expect(patch.summary["sv"]).toBeUndefined();
    expect(patch.summary["zh-CN"]).toBeDefined();
    expect(patch.summary["zh"]).toBeUndefined();
    expect(patch.summary["pt-BR"]).toEqual(listings["pt-BR"].summary);
    for (const code of STORE_LOCALES["es-419"].amo) {
      expect(patch.description[code]).toEqual(listings["es-419"].description.join("\n\n"));
    }
  });

  test("every code is sent, English's, or not on AMO's list", () => {
    const withAmo = LANGUAGES.flatMap((language) => STORE_LOCALES[language].amo);
    const sent = amoListings(listings)
      .map((one) => one.code)
      .sort();
    const taken = withAmo.filter((code) => AMO_LOCALES.has(code) && code !== "en-US").sort();
    expect(sent).toEqual(taken);
  });

  test("holds back exactly the codes AMO's list doesn't name", () => {
    const withAmo = LANGUAGES.flatMap((language) => STORE_LOCALES[language].amo);
    const blocked = blockedListings(listings)
      .map((one) => one.code)
      .sort();
    expect(blocked).toEqual(withAmo.filter((code) => !AMO_LOCALES.has(code)).sort());
    const patch = amoPatch(listings);
    for (const code of blocked) {
      expect(patch.summary[code]).toBeUndefined();
      expect(patch.description[code]).toBeUndefined();
    }
  });
});

describe("the JWT", () => {
  const config = { issuer: "user:12345678:123", secret: "a-fair-secret" };

  test("verifies against the secret it was signed with", async () => {
    const [header, payload, signature] = (await signJwt(config)).split(".") as [
      string,
      string,
      string,
    ];
    const decode = (part: string): Record<string, unknown> =>
      JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>;
    expect(decode(header)).toEqual({ alg: "HS256", typ: "JWT" });
    const claims = decode(payload);
    expect(claims.iss).toEqual(config.issuer);
    expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(5 * 60);

    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(config.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      "HMAC",
      key,
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(verified).toBe(true);
  });

  test("uses a fresh nonce every time, even with the same token issued at", async () => {
    const first = (await signJwt(config, 1_800_000_000)).split(".")[1];
    const second = (await signJwt(config, 1_800_000_000)).split(".")[1];
    expect(first).not.toEqual(second);
  });

  test("refuses a different secret", async () => {
    const [header, payload, signature] = (await signJwt(config)).split(".") as [
      string,
      string,
      string,
    ];
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("not-the-secret"),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      "HMAC",
      key,
      Buffer.from(signature, "base64url"),
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(verified).toBe(false);
  });
});

describe("the configuration", () => {
  test("takes its pair from the environment", () => {
    const config = loadAmoConfig({
      AMO_JWT_ISSUER: "user:12345678:123",
      AMO_JWT_SECRET: "the-secret",
    });
    expect(config.issuer).toEqual("user:12345678:123");
    expect(config.slug).toEqual("parousia");
    expect(config.base).toEqual("https://addons.mozilla.org/api/v5");
  });

  test("reads the overrides it takes", () => {
    const config = loadAmoConfig({
      AMO_JWT_ISSUER: "issued",
      AMO_JWT_SECRET: "secret",
      AMO_ADDON_SLUG: "other-addon",
      AMO_API_BASE: "http://127.0.0.1:54010/",
    });
    expect(config.slug).toEqual("other-addon");
    expect(config.base).toEqual("http://127.0.0.1:54010/");
  });

  test("refuses a missing or unfilled pair", () => {
    expect(() => loadAmoConfig({})).toThrow("AMO_JWT_ISSUER and AMO_JWT_SECRET");
    expect(() =>
      loadAmoConfig({
        AMO_JWT_ISSUER: "user:12345678:123",
        AMO_JWT_SECRET: "replace-with-the-secret-from-the-developer-hub",
      }),
    ).toThrow("AMO_JWT_ISSUER and AMO_JWT_SECRET");
  });
});
