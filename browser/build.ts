import { mkdir, rm } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { buildActivities } from "./scripts/activities/build";
import { loadDevKey } from "./scripts/dev-key";
import { iconsPlugin } from "./scripts/icons";
import { packLocale } from "./scripts/locales";
import { atJsonFloor } from "./scripts/json";
import {
  PACKAGE_LANGUAGES,
  STORE_LOCALES,
  SUMMARY_MESSAGE,
  chromeMessages,
  loadListings,
  type PackageTarget,
} from "./scripts/store";
import { LANGUAGES, type Language } from "./src/core/i18n";
import { userscriptHeader, type HeaderSource } from "./scripts/userscript-header";
import { writeZip } from "./scripts/zip";

interface ExtensionManifest extends HeaderSource {
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

  if (target === "chromium") {
    // The Web Store dashboard lists a language for the listing only if the package
    // has its `_locales/<code>/`, and reads the summary from the manifest's
    // description there (see writeStoreLocales). Firefox Add-ons keeps its listing
    // languages in the Developer Hub, so that package stays as it is.
    manifest.default_locale = "en";
    manifest.description = `__MSG_${SUMMARY_MESSAGE}__`;
  }

  await Bun.write(join(targetDir, "manifest.json"), JSON.stringify(manifest));
}

const outDir = process.env.PAROUSIA_BUILD_DIR ?? "dist";
const extensionTargets = ["chromium", "firefox"] as const;
const logo = join("..", "assets", "brand", "parousia-rounded.svg");
/** Chromium shows only raster manifest icons (an SVG or WebP one falls back to the puzzle piece); `icons/` holds the PNGs. */
const chromiumIconSizes = [16, 32, 48, 128] as const;
const popupFonts = ["poppins-400.woff2", "poppins-600.woff2", "OFL.txt"] as const;

let plugins: Bun.BunPlugin[] = [];
/**
 * The languages the platform's package carries dictionaries for, injected as
 * `PACKAGED_LANGUAGES` into every bundle of the target (PACKAGE_LANGUAGES in
 * scripts/store.ts). The userscript, bundled outside the loop, gets all.
 */
let packagedLanguages: readonly Language[] = LANGUAGES;

async function bundle(
  entrypoint: string,
  targetDir: string,
  {
    format = "esm",
    naming,
    define,
  }: { format?: "esm" | "iife"; naming?: string; define?: Record<string, string> } = {},
): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: targetDir,
    target: "browser",
    format,
    ...(naming && { naming }),
    // Bun reads each define value as the JSON it names and hands the bundle the
    // constant, so the array goes in as its JSON *text* and `PACKAGED` parses
    // it at runtime; an array here arrives as a bare `en,am,…` string instead.
    define: {
      PACKAGED_LANGUAGES: JSON.stringify(JSON.stringify(packagedLanguages)),
      ...define,
    },
    minify: true,
    plugins,
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

async function writeCss(source: string, targetDir: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [source],
    outdir: targetDir,
    minify: true,
    external: ["*.woff2"],
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`build failed for ${source}`);
  }
}

async function writeTheme(targetDir: string): Promise<void> {
  await writeCss(join("src", "shared", "theme.css"), targetDir);
  // A classic script, loaded in <head> so the chosen theme is on before the first paint.
  await bundle(join("src", "shared", "theme-boot.ts"), targetDir, {
    format: "iife",
    naming: "theme.js",
  });
}

async function writePopup(targetDir: string): Promise<void> {
  await bundle(join("src", "popup", "popup.ts"), targetDir);
  await copyFile(join("src", "popup", "popup.html"), join(targetDir, "popup.html"));
  await writeCss(join("src", "popup", "popup.css"), targetDir);
}

async function writeFullscreen(targetDir: string): Promise<void> {
  await bundle(join("src", "fullscreen", "fullscreen.ts"), targetDir);
  await copyFile(join("src", "fullscreen", "fullscreen.html"), join(targetDir, "fullscreen.html"));
  await writeCss(join("src", "fullscreen", "fullscreen.css"), targetDir);
}

/**
 * The screens' dictionaries for the target's package (`locales/<code>.json`):
 * only the languages the platform's own list names (PACKAGE_LANGUAGES in
 * scripts/store.ts), so a package doesn't carry text its browser can't run:
 * Firefox has no Amharic or Swahili, Chromium takes every language today, and
 * a language may reach one package and not the other.
 */
async function writeLocales(target: PackageTarget, targetDir: string): Promise<void> {
  const localesDir = join(targetDir, "locales");
  await mkdir(localesDir, { recursive: true });
  for (const language of PACKAGE_LANGUAGES[target]) {
    // English's dictionary is the source's keys (i18n.ts), so there's nothing to write.
    if (language === "en") continue;
    const source = await Bun.file(join("src", "locales", `${language}.json`)).text();
    await Bun.write(join(localesDir, `${language}.json`), atJsonFloor(packLocale(source)));
  }
}

/**
 * The Chromium package's `_locales/`: the store summary in each language, which
 * is all Chrome reads from it. The extension's own screens use `locales/`.
 * What lands here follows the same set the package's dictionaries do
 * (PACKAGE_LANGUAGES): a store listing the browser's own list doesn't name
 * stays a paste-file (`bun run store export`), and the package stays smaller.
 */
async function writeStoreLocales(targetDir: string): Promise<void> {
  const listings = await loadListings();
  for (const language of PACKAGE_LANGUAGES.chromium) {
    const dir = join(targetDir, "_locales", STORE_LOCALES[language].chrome);
    await mkdir(dir, { recursive: true });
    await Bun.write(join(dir, "messages.json"), atJsonFloor(chromeMessages(listings[language])));
  }
}

async function writeLegal(targetDir: string): Promise<void> {
  await copyFile(join("..", "LICENSE"), join(targetDir, "LICENSE"));
  await copyFile("THIRD-PARTY-NOTICES.txt", join(targetDir, "THIRD-PARTY-NOTICES.txt"));
}

async function writeIcons(
  target: (typeof extensionTargets)[number],
  targetDir: string,
): Promise<void> {
  const iconsDir = join(targetDir, "icons");
  await mkdir(iconsDir, { recursive: true });
  await copyFile(logo, join(iconsDir, "parousia.svg"));
  if (target !== "chromium") return;
  for (const size of chromiumIconSizes) {
    const name = `icon-${size}.png`;
    await copyFile(join("icons", name), join(iconsDir, name));
  }
}

async function writeUserscript(targetDir: string): Promise<void> {
  const manifest = (await Bun.file(join("manifests", "chromium.json")).json()) as ExtensionManifest;
  await bundle(join("src", "userscript", "index.ts"), targetDir, {
    define: { USERSCRIPT_VERSION: JSON.stringify(manifest.version) },
  });
  const header = userscriptHeader(manifest);

  const bundlePath = join(targetDir, "index.js");
  const bundled = await Bun.file(bundlePath).text();
  const script = header + bundled;
  await Bun.write(join(targetDir, "parousia.user.js"), script);
  // A manager installs the plain file; the .gz is for mirrors that serve it precompressed.
  await Bun.write(join(targetDir, "parousia.user.js.gz"), gzipSync(script, { level: 9 }));
  await rm(bundlePath);
}

async function build(dev: boolean): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  const activities = await buildActivities();
  for (const line of activities.summary) console.log(`[build] ${line}`);
  plugins = [activities.plugin, iconsPlugin];

  for (const target of extensionTargets) {
    const targetDir = join(outDir, target);
    await mkdir(targetDir, { recursive: true });
    packagedLanguages = PACKAGE_LANGUAGES[target];
    await bundle(join("src", "platforms", `${target}.ts`), targetDir);
    await writeIcons(target, targetDir);
    await writeLegal(targetDir);
    await writeFonts(targetDir);
    await writeTheme(targetDir);
    await writePopup(targetDir);
    await writeFullscreen(targetDir);
    await writeLocales(target, targetDir);
    if (target === "chromium") await writeStoreLocales(targetDir);
    await activities.writeTo(targetDir);
    await writeManifest(target, targetDir, dev);

    await writeZip(targetDir, join(outDir, `${target}.zip`));
  }

  packagedLanguages = PACKAGE_LANGUAGES.userscript;
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
