import { mkdir, rm } from "node:fs/promises";
import { watch } from "node:fs";
import { join } from "node:path";

interface ExtensionManifest {
  manifest_version: number;
  [key: string]: unknown;
}

async function writeManifest(target: string, targetDir: string): Promise<void> {
  const manifestPath = join("manifests", `${target}.json`);
  const manifest = (await Bun.file(manifestPath).json()) as ExtensionManifest;

  if (manifest.manifest_version !== 3) {
    throw new Error(`${manifestPath} must declare "manifest_version": 3`);
  }

  await Bun.write(join(targetDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

const outDir = "dist";
const extensionTargets = ["chromium", "firefox", "safari"] as const;

async function bundle(entrypoint: string, targetDir: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    outdir: targetDir,
    target: "browser",
    format: "esm",
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error(`build failed for ${entrypoint}`);
  }
}

async function build(): Promise<void> {
  await rm(outDir, { recursive: true, force: true });

  for (const target of extensionTargets) {
    const targetDir = join(outDir, target);
    await mkdir(targetDir, { recursive: true });
    await bundle(join("src", "platforms", `${target}.ts`), targetDir);
    await writeManifest(target, targetDir);
  }

  const userscriptDir = join(outDir, "userscript");
  await mkdir(userscriptDir, { recursive: true });
  await bundle(join("src", "userscript", "index.ts"), userscriptDir);

  console.log("[build] done");
}

await build();

if (process.argv.includes("--watch")) {
  console.log("[build] watching src/ for changes");
  watch("src", { recursive: true }, () => {
    build().catch((error: unknown) => console.error("[build] failed", error));
  });
}
