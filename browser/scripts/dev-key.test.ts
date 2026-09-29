import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { extensionIdFromPublicKeyDer } from "./dev-key";

describe("extensionIdFromPublicKeyDer", () => {
  test("matches Chromium's own algorithm reference implementation", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const der = publicKey.export({ type: "spki", format: "der" });

    // Independent reimplementation of crx_file::id_util::GenerateId, kept
    // deliberately separate from the module under test so this doesn't just
    // check the function against itself.
    const hash = createHash("sha256").update(der).digest();
    const expected = [...hash.subarray(0, 16).toString("hex")]
      .map((c) => "abcdefghijklmnop"[Number.parseInt(c, 16)])
      .join("");

    expect(extensionIdFromPublicKeyDer(der)).toBe(expected);
  });

  test("is 32 characters, all within a-p", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const der = publicKey.export({ type: "spki", format: "der" });

    const id = extensionIdFromPublicKeyDer(der);
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[a-p]{32}$/);
  });

  test("is deterministic for the same key", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const der = publicKey.export({ type: "spki", format: "der" });

    expect(extensionIdFromPublicKeyDer(der)).toBe(extensionIdFromPublicKeyDer(der));
  });

  test("differs between two distinct keys", () => {
    const a = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
      type: "spki",
      format: "der",
    });
    const b = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
      type: "spki",
      format: "der",
    });

    expect(extensionIdFromPublicKeyDer(a)).not.toBe(extensionIdFromPublicKeyDer(b));
  });
});
