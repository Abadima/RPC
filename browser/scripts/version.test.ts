import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { userscriptHeader } from "./userscript-header";

const root = join(import.meta.dir, "..");
const manifestDir = join(root, "manifests");

interface Manifest {
  manifest_version: number;
  version: string;
  description: string;
}

const read = async (name: string): Promise<Manifest> =>
  (await Bun.file(join(manifestDir, name)).json()) as Manifest;

/** Chromium accepts one to four dot-separated integers, and the stores reject anything else. */
const STORE_VERSION = /^(0|[1-9]\d{0,3})(\.(0|[1-9]\d{0,3})){0,3}$/;

describe("Firefox's data collection declaration", () => {
  // Mozilla counts data sent outside the browser, and an Activity's name and
  // text go to Parousia Desktop (and on to Discord), so "none" would be wrong.
  test('names what the extension sends to Desktop, never "none"', async () => {
    const manifest = (await Bun.file(join(manifestDir, "firefox.json")).json()) as {
      browser_specific_settings: {
        gecko: { data_collection_permissions: { required: string[] } };
      };
    };
    const { required } = manifest.browser_specific_settings.gecko.data_collection_permissions;
    expect(required).toEqual(["browsingActivity", "websiteContent"]);
  });
});

describe("the extension's version", () => {
  test("manifests exist only for targets that are built and released", async () => {
    expect((await readdir(manifestDir)).sort()).toEqual(["chromium.json", "firefox.json"]);
  });

  test("is the release in Chromium's manifest and package.json, in a form the stores accept", async () => {
    const chromium = await read("chromium.json");
    const pkg = (await Bun.file(join(root, "package.json")).json()) as { version: string };
    expect(chromium.version).toMatch(STORE_VERSION);
    expect(pkg.version).toBe(chromium.version);
  });

  test("is the release, or a store revision of it, in Firefox's manifest", async () => {
    // Mozilla takes each version once, so a fix to a released build goes out as 1.1.0.1.
    const release = (await read("chromium.json")).version;
    const firefox = (await read("firefox.json")).version;
    expect(firefox).toMatch(STORE_VERSION);
    expect(firefox === release || firefox.startsWith(`${release}.`)).toBe(true);
  });

  test("is the 1.1.0 release", async () => {
    // Bump this with the manifests and package.json when the next release is cut.
    // Desktop versions on its own (desktop/Cargo.toml); the tag is the extension's.
    expect((await read("chromium.json")).version).toBe("1.1.0");
    expect((await read("firefox.json")).version).toBe("1.1.0.1");
  });

  test("is the userscript's version too", async () => {
    const { version, description } = await read("chromium.json");
    const header = userscriptHeader({ version, description });
    expect(header).toContain(`\n// @version      ${version}\n`);
    expect(header).toContain(`\n// @description  ${description}\n`);
    expect(header.startsWith("// ==UserScript==\n")).toBe(true);
    expect(header.endsWith("// ==/UserScript==\n")).toBe(true);
  });
});
