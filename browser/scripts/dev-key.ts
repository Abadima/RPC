// A per-machine RSA key that gives the Chromium dev build a stable extension
// id. Without one, an unpacked extension's id comes from the path it's loaded
// from, so Desktop's allowlist entry breaks whenever that path changes, which
// a sandboxed browser does on every grant (it sees the build through the
// document portal at a fresh path). The key is gitignored and only used by
// `bun run dev`; the plain build (CI, store submission) never sets the
// manifest's "key".

import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const KEY_PATH = join(import.meta.dirname, "..", ".dev-key.json");

export interface DevKey {
  /** base64 SubjectPublicKeyInfo DER, ready to drop into a manifest's "key" field. */
  key: string;
  /** The extension id Chromium computes from `key`. */
  id: string;
}

/**
 * Chromium's own unpacked-extension id algorithm (crx_file::id_util::GenerateId):
 * SHA-256 of the raw SubjectPublicKeyInfo DER, first 16 bytes, hex-encoded,
 * each hex digit mapped through the alphabet so the id only ever contains
 * a-p (matching the a-p range Chromium ids are always drawn from).
 */
export function extensionIdFromPublicKeyDer(der: ArrayBufferView | ArrayBuffer): string {
  const hash = createHash("sha256")
    .update(der as NodeJS.ArrayBufferView)
    .digest();
  const hex = hash.subarray(0, 16).toString("hex");
  return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join("");
}

function generate(): DevKey {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" });
  return { key: der.toString("base64"), id: extensionIdFromPublicKeyDer(der) };
}

/** Loads the cached dev key, generating and persisting one on first use. */
export async function loadDevKey(): Promise<DevKey> {
  if (existsSync(KEY_PATH)) {
    return JSON.parse(await readFile(KEY_PATH, "utf8")) as DevKey;
  }
  const devKey = generate();
  await writeFile(KEY_PATH, `${JSON.stringify(devKey, null, 2)}\n`);
  return devKey;
}
