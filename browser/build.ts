import { mkdir, rm } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { buildActivities } from "./scripts/activities/build";
import { loadDevKey } from "./scripts/dev-key";
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

  await Bun.write(join(targetDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** `PAROUSIA_BUILD_DIR` builds somewhere else, for checks that need a build of their own. */
const outDir = process.env.PAROUSIA_BUILD_DIR ?? "dist";
const extensionTargets = ["chromium", "firefox"] as const;
const iconSizes = [16, 32, 48, 128] as const;
const popupFonts = ["poppins-400.woff2", "poppins-600.woff2", "OFL.txt"] as const;

/** Resolves `parousia:activities` (the native Activities); set once per build. */
let plugins: Bun.BunPlugin[] = [];

async function bundle(
  entrypoint: string,
  targetDir: string,
  { format = "esm", naming }: { format?: "esm" | "iife"; naming?: string } = {},
): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: targetDir,
    target: "browser",
    format,
    ...(naming && { naming }),
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

/** Minified: the sources keep their comments, the build doesn't ship them. Fonts stay as files. */
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

/** The project's license and what else an extension carries, inside the package itself. */
async function writeLegal(targetDir: string): Promise<void> {
  await copyFile(join("..", "LICENSE"), join(targetDir, "LICENSE"));
  await copyFile("THIRD-PARTY-NOTICES.txt", join(targetDir, "THIRD-PARTY-NOTICES.txt"));
}

async function writeIcons(targetDir: string): Promise<void> {
  const iconsDir = join(targetDir, "icons");
  await mkdir(iconsDir, { recursive: true });
  for (const size of iconSizes) {
    const name = `icon-${size}.png`;
    await copyFile(join("icons", name), join(iconsDir, name));
  }
}

async function writeUserscript(targetDir: string): Promise<void> {
  await bundle(join("src", "userscript", "index.ts"), targetDir);

  const manifest = (await Bun.file(join("manifests", "chromium.json")).json()) as ExtensionManifest;
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
  // Native Activities are bundled in; PreMiD's are packaged files (see scripts/activities/).
  const activities = await buildActivities();
  for (const line of activities.summary) console.log(`[build] ${line}`);
  plugins = [activities.plugin];

  for (const target of extensionTargets) {
    const targetDir = join(outDir, target);
    await mkdir(targetDir, { recursive: true });
    await bundle(join("src", "platforms", `${target}.ts`), targetDir);
    await writeIcons(targetDir);
    await writeLegal(targetDir);
    await writeFonts(targetDir);
    await writeTheme(targetDir);
    await writePopup(targetDir);
    await writeFullscreen(targetDir);
    await activities.writeTo(targetDir);
    await writeManifest(target, targetDir, dev);

    // Store uploads (AMO, Chrome Web Store) and release assets.
    await writeZip(targetDir, join(outDir, `${target}.zip`));
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
