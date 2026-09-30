import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * Where the extension's Activities come from. Each source is a Git
 * repository whose `main` branch is what a build includes: `bun run
 * activities:fetch` moves the checkout under .cache/activities/<name> to
 * `main`'s newest commit, and the revision a build used is recorded in its
 * catalog (and printed), for debugging, not as a pin. A fetch that fails
 * never touches a checkout that works, so a build offline, or while GitHub
 * is down, uses what was fetched last. An environment variable points a
 * build at a local checkout instead (for working on an Activity).
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
}

export interface Source extends Repository {
  name: SourceName;
  /** The revision in use: what's checked out, or what a local checkout has ("local" outside Git). */
  commit: string;
  dir: string;
  /** From an environment variable rather than the fetched checkout. */
  local: boolean;
}

/** A source that isn't there, and what to do about it. */
export interface MissingSource {
  name: SourceName;
  missing: string;
}

const BRANCH = /^[A-Za-z0-9._/-]+$/;

async function readSources(): Promise<Record<SourceName, Repository>> {
  const value: unknown = await Bun.file(SOURCES_FILE).json();
  const read = (name: SourceName): Repository => {
    const entry: unknown =
      typeof value === "object" && value !== null ? Reflect.get(value, name) : null;
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
      throw new Error(
        `activity-sources.json: "${name}" needs a GitHub "repository" and a "branch"`,
      );
    }
    return { repository, branch };
  };
  return { parousia: read("parousia"), premid: read("premid") };
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

/** Every source, and where it is on disk. */
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
  /** The revision in use afterwards. */
  commit: string;
  /** What it was before, if there was a checkout. */
  previous: string | null;
  /** The fetch failed (or brought something unusable), so the earlier checkout stays. */
  stale: boolean;
}

export interface SyncOptions {
  /** Tries before giving up on the network. */
  attempts?: number;
  /** Milliseconds before the second try, doubling after. */
  delay?: number;
}

/**
 * Brings the checkout in `dir` to the newest commit on `branch`. The fetch
 * only adds objects and the checkout only happens after it succeeded, so a
 * network failure leaves a working checkout exactly as it was; a commit
 * that turns out unusable is undone. Only a source that was never fetched
 * has no fallback, and that is an error (leaving nothing half-made behind).
 */
export async function syncSource(
  { repository, branch }: Repository,
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

/** Set to use what's already fetched without asking the network (an airplane, a flaky connection). */
export const OFFLINE_ENV = "PAROUSIA_ACTIVITIES_OFFLINE";

/**
 * Moves every source's checkout to its branch's newest commit (`syncSource`),
 * except one a local checkout stands in for (`SOURCE_ENV`). Builds call this
 * themselves, so an extension is always made from what each repository has
 * now, not from whatever was fetched last time.
 */
export async function fetchSources(log: (line: string) => void): Promise<SyncResult[]> {
  const sources = await readSources();
  const results: SyncResult[] = [];
  for (const name of SOURCE_NAMES) {
    if (process.env[SOURCE_ENV[name]]) continue;
    const { branch } = sources[name];
    const result = await syncSource(sources[name], join(CACHE_DIR, name), log);
    const was = result.previous?.slice(0, 12);
    const now = result.commit.slice(0, 12);
    log(
      result.stale
        ? `${name}: ${branch} at ${now} (stale)`
        : was && was !== now
          ? `${name}: ${branch} ${was} -> ${now}`
          : `${name}: ${branch} at ${now}`,
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
