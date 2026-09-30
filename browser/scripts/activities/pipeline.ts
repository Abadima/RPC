import type { ActivityInfo } from "../../src/core/activity";
import { activityId, websiteFolders } from "./discover";
import { adaptNative, type NativeFound } from "./native";
import { adaptPremid, readDmca, type Exclusion, type PremidFound } from "./premid";
import type { SourceName } from "./sources";

/**
 * Discovery for both sources, one pipeline: walk `websites/<letter>/<Name>/`
 * (discover.ts), read each folder with its source's adapter (native.ts,
 * premid.ts), and get the same manifest either way. A native problem is the
 * build's to fix; a PreMiD Activity that doesn't fit is left out and listed.
 */
export interface Discovery {
  native: NativeFound[];
  premid: PremidFound[];
  /** Native Activities' problems: any stops the build. */
  problems: string[];
  /** PreMiD Activities left out, and why. */
  excluded: Exclusion[];
}

export async function discover(source: SourceName, root: string): Promise<Discovery> {
  const discovery: Discovery = { native: [], premid: [], problems: [], excluded: [] };
  const folders = await websiteFolders(root);
  if (source === "parousia") {
    const ids = new Map<string, string>();
    const keys = new Map<string, string>();
    for (const folder of folders) {
      const id = activityId(folder.name);
      const other = ids.get(id);
      if (other) {
        discovery.problems.push(`${folder.path}: its id, "${id}", is also ${other}'s`);
        continue;
      }
      const key = websiteKey(id);
      const same = keys.get(key);
      if (same) {
        discovery.problems.push(
          `${folder.path}: it is the same website as ${same}'s (names that differ only in punctuation or spacing)`,
        );
        continue;
      }
      ids.set(id, folder.path);
      keys.set(key, folder.path);
      const { found, problems } = await adaptNative(folder);
      discovery.problems.push(...problems.map((problem) => `${folder.path}: ${problem}`));
      if (found) discovery.native.push(found);
    }
    return discovery;
  }
  const blocked = await readDmca(root);
  for (const folder of folders) {
    const result = await adaptPremid(folder, blocked);
    if ("reason" in result) discovery.excluded.push(result);
    else discovery.premid.push(result);
  }
  return discovery;
}

/**
 * What makes two Activities the same website: their folder names (an id, see
 * `activityId`) with the punctuation and spacing left out, so `Discord.js`,
 * `DiscordJS`, and `Discord JS` are one. It is never the display name, and
 * never a site they happen to share: `Google` and `Google Docs` both read
 * google.com and are two websites. A name with no letters or digits has no
 * identity, and links to nothing.
 */
export function websiteKey(id: string): string {
  return id.replaceAll("-", "");
}

/**
 * Marks every website both sources implement: each implementation gets the
 * list of all of them (`ActivityInfo.variants`), the native one first. The
 * same website is the same folder name (`websiteKey`) in both repositories,
 * which share PreMiD's layout. Only one of them runs, whichever the user
 * chose (the native one until then), and the dashboard lists them once.
 */
export function linkVariants(
  native: ReadonlyArray<{ site: string; manifest: { info: ActivityInfo } }>,
  premid: ReadonlyArray<{ site: string; manifest: { info: ActivityInfo } }>,
): void {
  const bySite = new Map<string, Array<{ info: ActivityInfo }>>();
  for (const { site, manifest } of premid) {
    const key = websiteKey(site);
    if (key) bySite.set(key, [...(bySite.get(key) ?? []), manifest]);
  }
  for (const { site, manifest } of native) {
    const others = bySite.get(websiteKey(site));
    if (!others) continue;
    const variants = [manifest.info.id, ...others.map((other) => other.info.id)];
    for (const member of [manifest, ...others]) member.info.variants = variants;
  }
}
