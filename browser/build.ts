import { mkdir, rm } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { loadDevKey } from "./scripts/dev-key";
import { writeZip } from "./scripts/zip";

interface ExtensionManifest {
  manifest_version: number;
  [key: string]: unknown;
}

/**
 * `dev` (only `bun run dev`) gives the Chromium build the per-machine dev key
 * as its manifest "key", so its id doesn't change with the load path (see
 * scripts/dev-key.ts). The plain build never sets it.
 */
async function writeManifest(target: string, targetDir: string, dev: boolean): Promise<void> {
  const manifestPath = join("manifests", `${target}.json`);
  const manifest = (await Bun.file(manifestPath).json()) as ExtensionManifest;

  if (manifest.manifest_version !== 3) {
    throw new Error(`${manifestPath} must declare "manifest_version": 3`);
  }

  if (dev && target === "chromium") {
    const devKey = await loadDevKey();
    manifest.key = devKey.key;
    console.log(`[build] dev id for chromium: chrome-extension://${devKey.id}`);
    console.log(`[build]   allow it: \`Parousia-Desktop allow chrome-extension://${devKey.id}\``);
  }

  await Bun.write(join(targetDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

const outDir = "dist";
const extensionTargets = ["chromium", "firefox", "safari"] as const;
const iconSizes = [16, 32, 48, 128] as const;
const popupFonts = ["poppins-400.woff2", "poppins-600.woff2", "OFL.txt"] as const;

async function bundle(entrypoint: string, targetDir: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: targetDir,
    target: "browser",
    format: "esm",
    minify: true,
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error(`build failed for ${entrypoint}`);
  }
}

async function copyFile(source: string, destination: string): Promise<void> {
  await Bun.write(destination, Bun.file(source));
}

async function writeFonts(targetDir: string): Promise<void> {
  const fontsDir = join(targetDir, "fonts");
  await mkdir(fontsDir, { recursive: true });
  for (const font of popupFonts) {
    await copyFile(join("src", "popup", "fonts", font), join(fontsDir, font));
  }
}

async function writeTheme(targetDir: string): Promise<void> {
  await copyFile(join("src", "shared", "theme.css"), join(targetDir, "theme.css"));
}

async function writePopup(targetDir: string): Promise<void> {
  await bundle(join("src", "popup", "popup.ts"), targetDir);
  await copyFile(join("src", "popup", "popup.html"), join(targetDir, "popup.html"));
  await copyFile(join("src", "popup", "popup.css"), join(targetDir, "popup.css"));
}

async function writeFullscreen(targetDir: string): Promise<void> {
  await bundle(join("src", "fullscreen", "fullscreen.ts"), targetDir);
  await copyFile(join("src", "fullscreen", "fullscreen.html"), join(targetDir, "fullscreen.html"));
  await copyFile(join("src", "fullscreen", "fullscreen.css"), join(targetDir, "fullscreen.css"));
}

async function writeIcons(targetDir: string): Promise<void> {
  const iconsDir = join(targetDir, "icons");
  await mkdir(iconsDir, { recursive: true });
  for (const size of iconSizes) {
    const name = `icon-${size}.png`;
    await copyFile(join("icons", name), join(iconsDir, name));
  }
}

/**
 * A userscript manager only recognizes a script as a userscript, and only
 * knows what to run it on, from an `==UserScript==` metadata block (and a
 * `.user.js` file name to offer installing it). The one grant is a menu
 * command for checking the connection, since a userscript has no popup.
 * `@inject-into content` (Violentmonkey) and `@sandbox DOM` (Tampermonkey)
 * run it in the isolated world, out of reach of the page's own scripts.
 * `@noframes` keeps embedded iframes from each opening their own connection.
 * Matching every site mirrors the extension's own `tabs` permission: broad
 * reach is inherent to "detect activity on whatever site the user is on".
 */
async function writeUserscript(targetDir: string): Promise<void> {
  await bundle(join("src", "userscript", "index.ts"), targetDir);

  const manifest = (await Bun.file(join("manifests", "chromium.json")).json()) as ExtensionManifest;
  const header = [
    "// ==UserScript==",
    "// @name         Parousia",
    "// @namespace    https://github.com/Abadima/RPC",
    `// @version      ${manifest.version}`,
    `// @description  ${manifest.description}`,
    "// @match        *://*/*",
    "// @run-at       document-start",
    "// @noframes",
    "// @inject-into  content",
    "// @sandbox      DOM",
    "// @grant        GM_registerMenuCommand",
    "// ==/UserScript==",
    "",
  ].join("\n");

  const bundlePath = join(targetDir, "index.js");
  const bundled = await Bun.file(bundlePath).text();
  await Bun.write(join(targetDir, "parousia.user.js"), header + bundled);
  await rm(bundlePath);
}

async function build(dev: boolean): Promise<void> {
  await rm(outDir, { recursive: true, force: true });

  for (const target of extensionTargets) {
    const targetDir = join(outDir, target);
    await mkdir(targetDir, { recursive: true });
    await bundle(join("src", "platforms", `${target}.ts`), targetDir);
    await writeIcons(targetDir);
    await writeFonts(targetDir);
    await writeTheme(targetDir);
    await writePopup(targetDir);
    await writeFullscreen(targetDir);
    await writeManifest(target, targetDir, dev);

    if (target === "firefox") {
      await writeZip(targetDir, join(outDir, "firefox.zip"));
    }
  }

  await writeUserscript(join(outDir, "userscript"));

  console.log("[build] done");
}

const isDev = process.argv.includes("--watch") || process.argv.includes("--dev");
await build(isDev);

if (process.argv.includes("--watch")) {
  console.log("[build] watching src/ for changes");
  watch("src", { recursive: true }, () => {
    build(isDev).catch((error: unknown) => console.error("[build] failed", error));
  });
}
