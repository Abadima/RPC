import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CATALOG_PATH,
  COLLECTOR_PATH,
  HOSTS_PATH,
  INDEX_PATH,
  PREMID_RUNTIME_PATH,
  catalogEntry,
  manifestPath,
  nativeFile,
  premidFile,
  type Catalog,
  type CatalogIndex,
  type HostIndex,
} from "../../src/activities/manifest";
import type { NativeFound } from "./native";
import { discover, linkVariants } from "./pipeline";
import { activitiesPlugin } from "./plugin";
import { compilePremid, readStrings, type Exclusion, type PremidFound } from "./premid";
import { BROWSER_DIR, refreshSources, resolveSources } from "./sources";

export interface ActivitiesBuild {
  native: NativeFound[];
  premid: PremidFound["manifest"][];
  /** PreMiD Activities left out, and why. */
  excluded: Exclusion[];
  /** Resolves `parousia:activities` in the extension's bundles. */
  plugin: Bun.BunPlugin;
  /** What was included, from where, for the build's output. */
  summary: string[];
  /** Writes the packaged Activity files (`activities/`) into an extension's output folder. */
  writeTo(targetDir: string): Promise<void>;
}

async function bundleScript(entry: string, define: Record<string, string> = {}): Promise<string> {
  const result = await Bun.build({
    entrypoints: [join(BROWSER_DIR, "src", ...entry.split("/"))],
    target: "browser",
    format: "iife",
    minify: true,
    define,
  });
  const [output] = result.outputs;
  if (!result.success || !output)
    throw new Error(`${entry} failed to build: ${result.logs.join("\n")}`);
  return output.text();
}

/**
 * Finds, checks, and compiles every Activity from the sources in
 * activity-sources.json (sources.ts, each at the revision fetched from its
 * `main`, recorded in the catalog), both through the same pipeline
 * (pipeline.ts), into one catalog. Every build first brings each fetched
 * source to its newest commit; if the network fails it uses the copy it has
 * and says so, and with no copy at all it stops. A problem with a native
 * Activity stops the build; a PreMiD Activity that doesn't fit is left out
 * and listed.
 */
export async function buildActivities(): Promise<ActivitiesBuild> {
  const summary: string[] = [];
  const files = new Map<string, string>();
  const catalog: Catalog = { sources: {}, activities: [] };
  let native: NativeFound[] = [];
  let premid: PremidFound[] = [];
  const excluded: Exclusion[] = [];

  // Each source at its repository's newest commit, every time (see sources.ts).
  await refreshSources((line) => summary.push(line));
  for (const source of await resolveSources()) {
    if ("missing" in source) {
      summary.push(`${source.name}: no Activities (${source.missing})`);
      continue;
    }
    const at = source.local
      ? `${source.dir}, ${source.commit.slice(0, 12)}`
      : source.commit.slice(0, 12);
    catalog.sources[source.name] = source.commit;
    const discovery = await discover(source.name, source.dir);
    if (discovery.problems.length > 0) {
      throw new Error(
        `native Activities (${at}) have problems:\n  ${discovery.problems.join("\n  ")}`,
      );
    }
    if (source.name === "parousia") {
      native = discovery.native;
      summary.push(
        `parousia: ${native.length} native ${native.length === 1 ? "Activity" : "Activities"} (${at})`,
      );
      continue;
    }

    const compiled = await compilePremid(source.dir, discovery.premid);
    premid = compiled.activities;
    excluded.push(...discovery.excluded, ...compiled.excluded);
    for (const [name, script] of compiled.scripts) files.set(`activities/premid/${name}`, script);
    const general = await readStrings(join(source.dir, "websites", "general.json"));
    files.set(
      PREMID_RUNTIME_PATH,
      await bundleScript("premid/runtime.ts", { __PREMID_STRINGS__: JSON.stringify(general) }),
    );
    files.set("activities/premid/LICENSE.txt", await Bun.file(join(source.dir, "LICENSE")).text());
    files.set(
      "activities/premid/SOURCE.txt",
      [
        "The scripts in this folder are PreMiD's Activities, compiled unchanged",
        "(apart from a wrapper that hands them Parousia's Presence and iFrame)",
        `from ${source.repository}/tree/${source.commit} (its ${source.branch} branch when built)`,
        "under the Mozilla Public License 2.0 (LICENSE.txt).",
        "",
      ].join("\n"),
    );
    summary.push(`premid: ${premid.length} PreMiD Activities, ${excluded.length} left out (${at})`);
  }

  // Websites both sources implement: each gets the list, before anything is written.
  linkVariants(native, premid);
  const shared = native.filter((entry) => entry.manifest.info.variants).length;
  if (shared > 0) {
    summary.push(`${shared} ${shared === 1 ? "website is" : "websites are"} in both sources`);
  }

  // One catalog, one index, one host index: native Activities first (they
  // win where both cover a site, and are the default choice), then PreMiD's.
  const manifests = [
    ...native.map((entry) => ({
      manifest: entry.manifest,
      file: nativeFile(entry.manifest.info.id),
    })),
    ...premid.map((entry) => ({
      manifest: entry.manifest,
      file: premidFile(entry.manifest.script.file),
    })),
  ];
  const index: CatalogIndex = { files: {} };
  const hosts: HostIndex = { hosts: {} };
  for (const { manifest, file } of manifests) {
    const { info } = manifest;
    catalog.activities.push(catalogEntry(info));
    index.files[info.id] = file;
    files.set(manifestPath(file), JSON.stringify(manifest));
    for (const host of info.hosts) hosts.hosts[host] = [...(hosts.hosts[host] ?? []), file];
  }
  files.set(CATALOG_PATH, JSON.stringify(catalog));
  files.set(INDEX_PATH, JSON.stringify(index));
  files.set(HOSTS_PATH, JSON.stringify(hosts));
  files.set(COLLECTOR_PATH, await bundleScript("activities/collector-entry.ts"));

  return {
    native,
    premid: premid.map((entry) => entry.manifest),
    excluded,
    plugin: activitiesPlugin(native),
    summary,
    async writeTo(targetDir) {
      const folders = new Set([...files.keys()].map((path) => dirname(join(targetDir, path))));
      for (const folder of folders) await mkdir(folder, { recursive: true });
      await Promise.all(
        [...files].map(([path, content]) => Bun.write(join(targetDir, path), content)),
      );
    },
  };
}
