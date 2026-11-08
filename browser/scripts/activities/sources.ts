import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where the extension's Activities come from: a Git repository and branch
 * each, usually pinned to a reviewed commit (`revision`). A build uses the
 * pin and refuses any other checkout; `main` moving on is reported, and the
 * pin moves only when someone edits activity-sources.json. `bun run
 * activities:fetch` brings .cache/activities/<name> to it. A fetch that fails
 * never touches a checkout that works, so a build offline uses what was
 * fetched last. An environment variable points a build at a local checkout
 * instead, for working on an Activity (pins don't apply to it).
 */
export type SourceName = "parousia" | "premid";
export const SOURCE_NAMES: readonly SourceName[] = ["parousia", "premid"];

export const SOURCE_ENV: Record<SourceName, string> = {
  parousia: "PAROUSIA_ACTIVITIES_DIR",
  premid: "PREMID_ACTIVITIES_DIR",
};

export const BROWSER_DIR = join(import.meta.dir, "..", "..");
const SOURCES_FILE = join(BROWSER_DIR, "activity-sources.json");
export const CACHE_DIR = join(BROWSER_DIR, ".cache", "activities");

export interface Repository {
  repository: string;
  branch: string;
  revision?: string;
}

export interface Source extends Repository {
  name: SourceName;
  commit: string;
  dir: string;
  local: boolean;
}

export interface MissingSource {
  name: SourceName;
  missing: string;
}

const BRANCH = /^[A-Za-z0-9._/-]+$/;
const REVISION = /^[0-9a-f]{40}$/;

export function readRepository(name: SourceName, entry: unknown): Repository {
  const field = (key: string): unknown =>
    typeof entry === "object" && entry !== null ? Reflect.get(entry, key) : null;
  const repository = field("repository");
  const branch = field("branch");
  if (
    typeof repository !== "string" ||
    !repository.startsWith("https://github.com/") ||
    typeof branch !== "string" ||
    !BRANCH.test(branch) ||
    branch.startsWith("-")
  ) {
    throw new Error(`activity-sources.json: "${name}" needs a GitHub "repository" and a "branch"`);
  }
  const revision = field("revision");
  if (revision === undefined || revision === null) return { repository, branch };
  if (typeof revision !== "string" || !REVISION.test(revision)) {
    throw new Error(
      `activity-sources.json: "${name}"'s "revision" must be the full 40-character commit id to pin`,
    );
  }
  return { repository, branch, revision };
}

async function readSources(): Promise<Record<SourceName, Repository>> {
  const value: unknown = await Bun.file(SOURCES_FILE).json();
  return {
    parousia: readRepository(
      "parousia",
      typeof value === "object" && value !== null ? Reflect.get(value, "parousia") : null,
    ),
    premid: readRepository(
      "premid",
      typeof value === "object" && value !== null ? Reflect.get(value, "premid") : null,
    ),
  };
}

export async function git(args: string[], cwd?: string): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${err.trim()}`);
  return out.trim();
}

/** What a fetched checkout is at, if it's a usable one: a commit with the `websites/` folder both sources use. */
async function checkedOut(dir: string): Promise<string | null> {
  if (!existsSync(join(dir, ".git")) || !existsSync(join(dir, "websites"))) return null;
  return git(["rev-parse", "HEAD"], dir).catch(() => null);
}

export async function resolveSources(): Promise<Array<Source | MissingSource>> {
  const sources = await readSources();
  return Promise.all(
    SOURCE_NAMES.map(async (name): Promise<Source | MissingSource> => {
      const repository = sources[name];
      const local = process.env[SOURCE_ENV[name]];
      if (local) {
        if (!existsSync(local))
          return { name, missing: `${SOURCE_ENV[name]} is ${local}, which doesn't exist` };
        const commit = await git(["rev-parse", "HEAD"], local).catch(() => "local");
        return { name, ...repository, commit, dir: local, local: true };
      }
      const dir = join(CACHE_DIR, name);
      const commit = await checkedOut(dir);
      if (commit === null)
        return { name, missing: "isn't fetched: run `bun run activities:fetch`" };
      return { name, ...repository, commit, dir, local: false };
    }),
  );
}

export interface SyncResult {
  commit: string;
  previous: string | null;
  stale: boolean;
}

export interface SyncOptions {
  attempts?: number;
  delay?: number;
}

/**
 * Whether the object store has this commit (a shallow checkout holds every
 * revision it has ever been at, plus whatever the newest fetch brought).
 */
async function hasCommit(dir: string, revision: string): Promise<boolean> {
  return git(["cat-file", "-e", `${revision}^{commit}`], dir).then(
    () => true,
    () => false,
  );
}

/**
 * Brings the checkout in `dir` to its pin, or without one to the newest
 * commit on `branch`. The fetch only adds objects and the checkout happens
 * only after it succeeded, so a network failure leaves a working checkout as
 * it was, and a commit that turns out unusable is undone. Only a source that
 * was never fetched has no fallback, which is an error.
 *
 * A pin is reached by deepening the shallow fetch of `branch` until it's
 * there: servers don't generally hand over a commit by id (PreMiD's refuses).
 */
export async function syncSource(
  { repository, branch, revision }: Repository,
  dir: string,
  log: (line: string) => void,
  { attempts = 3, delay = 1000 }: SyncOptions = {},
): Promise<SyncResult> {
  const previous = await checkedOut(dir);
  const fresh = previous === null;
  if (fresh) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    await git(["init", "-q"], dir);
  }
  await git(["remote", "remove", "origin"], dir).catch(() => "");
  await git(["remote", "add", "origin", repository], dir);

  const tracking = `refs/remotes/origin/${branch}`;
  let failure = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await git(
        ["fetch", "-q", "--depth", "1", "origin", `+refs/heads/${branch}:${tracking}`],
        dir,
      );
      failure = "";
      break;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      if (attempt < attempts) await Bun.sleep(delay * 2 ** (attempt - 1));
    }
  }

  const keep = async (why: string): Promise<SyncResult> => {
    if (previous === null) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(`${repository}: ${why}, and there's no earlier copy to use`);
    }
    log(`${repository}: ${why}; keeping ${previous.slice(0, 12)}`);
    return { commit: previous, previous, stale: true };
  };

  if (failure) return keep(`couldn't fetch ${branch} (${failure})`);
  const next = await git(["rev-parse", tracking], dir);

  if (revision === undefined) {
    if (next === previous) return { commit: next, previous, stale: false };
    try {
      await git(["checkout", "-q", "--force", "--detach", next], dir);
    } catch (error) {
      if (previous !== null) await git(["checkout", "-q", "--force", "--detach", previous], dir);
      return keep(`couldn't check out ${next.slice(0, 12)} (${String(error)})`);
    }
    if (!existsSync(join(dir, "websites"))) {
      if (previous !== null) await git(["checkout", "-q", "--force", "--detach", previous], dir);
      return keep(`${next.slice(0, 12)} has no websites/ folder`);
    }
    return { commit: next, previous, stale: false };
  }

  const pin = revision;
  if (next !== pin)
    log(
      `${repository}: ${branch} is at ${next.slice(0, 12)}; keeping the pinned ${pin.slice(0, 12)} (edit activity-sources.json to move it)`,
    );

  const settle = async (): Promise<SyncResult> => {
    try {
      await git(["checkout", "-q", "--force", "--detach", pin], dir);
    } catch (error) {
      if (previous !== null) await git(["checkout", "-q", "--force", "--detach", previous], dir);
      return keep(`couldn't check out the pinned ${pin.slice(0, 12)} (${String(error)})`);
    }
    if (!existsSync(join(dir, "websites"))) {
      if (previous !== null) await git(["checkout", "-q", "--force", "--detach", previous], dir);
      return keep(`the pinned ${pin.slice(0, 12)} has no websites/ folder`);
    }
    return { commit: pin, previous, stale: false };
  };

  // The pin's objects are in the object store already: the checkout was on it
  // (or the fetch that showed `next` was it). No more network needed.
  if (next === pin || previous === pin || (await hasCommit(dir, pin))) return settle();

  // A checkout that was never on the pin: fetch `main`'s history more deeply
  // until the pin turns up (pins sit close to `main` in practice).
  for (const depth of [8, 32, 128, 512]) {
    try {
      await git(
        ["fetch", "-q", "--depth", String(depth), "origin", `+refs/heads/${branch}:${tracking}`],
        dir,
      );
    } catch (error) {
      return keep(`couldn't fetch the pinned ${pin.slice(0, 12)} (${String(error)})`);
    }
    const tip = await git(["rev-parse", tracking], dir);
    if (tip === pin || (await hasCommit(dir, pin))) return settle();
  }
  return keep(
    `${branch} has advanced further back than 512 commits past the pinned ${pin.slice(0, 12)}`,
  );
}

export const OFFLINE_ENV = "PAROUSIA_ACTIVITIES_OFFLINE";

/**
 * Moves every source's checkout to its pin, or without one to its branch's
 * newest commit (`syncSource`), except one a local checkout stands in for
 * (`SOURCE_ENV`). Builds call this themselves.
 */
export async function fetchSources(log: (line: string) => void): Promise<SyncResult[]> {
  const sources = await readSources();
  const results: SyncResult[] = [];
  for (const name of SOURCE_NAMES) {
    if (process.env[SOURCE_ENV[name]]) continue;
    const { branch, revision } = sources[name];
    const result = await syncSource(sources[name], join(CACHE_DIR, name), log);
    const was = result.previous?.slice(0, 12);
    const now = result.commit.slice(0, 12);
    const at = revision === undefined ? branch : "pin";
    log(
      result.stale
        ? `${name}: ${at} at ${now} (stale)`
        : was && was !== now
          ? `${name}: ${at} ${was} -> ${now}`
          : `${name}: ${at} at ${now}`,
    );
    results.push(result);
  }
  return results;
}

let refreshed: Promise<unknown> | null = null;

/** `fetchSources`, once per process (a watching build rebuilds often), and not at all when offline. */
export function refreshSources(log: (line: string) => void): Promise<unknown> {
  if (process.env[OFFLINE_ENV]) return Promise.resolve();
  refreshed ??= fetchSources(log);
  return refreshed;
}
