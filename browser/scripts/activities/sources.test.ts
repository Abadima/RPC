import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFFLINE_ENV, SOURCE_ENV, fetchSources, git, refreshSources, syncSource } from "./sources";

let root = "";
let origin = "";
let cache = "";
const quiet = { attempts: 2, delay: 1 };
const lines: string[] = [];
const log = (line: string): void => void lines.push(line);

async function commit(
  dir: string,
  files: Record<string, string>,
  message: string,
): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content);
  }
  await git(["add", "-A"], dir);
  await git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", message], dir);
  return git(["rev-parse", "HEAD"], dir);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "parousia-sources-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("Activity sources follow main, and a failed fetch never costs a working checkout", () => {
  test("the first fetch checks out main, and a later one follows it without any pin", async () => {
    origin = join(root, "origin");
    cache = join(root, "cache");
    await mkdir(origin);
    await git(["init", "-q", "-b", "main"], origin);
    const first = await commit(origin, { "websites/A/One/metadata.json": "{}" }, "one");
    const repo = { repository: origin, branch: "main" };

    const a = await syncSource(repo, cache, log, quiet);
    expect(a).toEqual({ commit: first, previous: null, stale: false });
    expect(await Bun.file(join(cache, "websites/A/One/metadata.json")).text()).toBe("{}");

    const unchanged = await syncSource(repo, cache, log, quiet);
    expect(unchanged).toEqual({ commit: first, previous: first, stale: false });

    const second = await commit(origin, { "websites/B/Two/metadata.json": "{}" }, "two");
    const b = await syncSource(repo, cache, log, quiet);
    expect(b).toEqual({ commit: second, previous: first, stale: false });
    expect(existsSync(join(cache, "websites/B/Two/metadata.json"))).toBe(true);
  });

  test("an unreachable repository keeps the checkout exactly as it was", async () => {
    const repo = { repository: origin, branch: "main" };
    const before = await git(["rev-parse", "HEAD"], cache);
    await rename(origin, `${origin}.away`);
    try {
      lines.length = 0;
      const result = await syncSource(repo, cache, log, quiet);
      expect(result).toEqual({ commit: before, previous: before, stale: true });
      expect(await git(["rev-parse", "HEAD"], cache)).toBe(before);
      expect(await git(["status", "--porcelain"], cache)).toBe("");
      expect(existsSync(join(cache, "websites/B/Two/metadata.json"))).toBe(true);
      expect(lines.join("\n")).toContain(`keeping ${before.slice(0, 12)}`);
    } finally {
      await rename(`${origin}.away`, origin);
    }
  });

  test("a branch that doesn't exist (or a deleted repository) is the same failure, not a wipe", async () => {
    const before = await git(["rev-parse", "HEAD"], cache);
    const result = await syncSource({ repository: origin, branch: "gone" }, cache, log, quiet);
    expect(result.stale).toBe(true);
    expect(await git(["rev-parse", "HEAD"], cache)).toBe(before);
  });

  test("a commit without websites/ is undone", async () => {
    const repo = { repository: origin, branch: "main" };
    const before = await git(["rev-parse", "HEAD"], cache);
    await git(["rm", "-rq", "websites"], origin);
    await commit(origin, { "README.md": "moved" }, "empty");
    const result = await syncSource(repo, cache, log, quiet);
    expect(result).toEqual({ commit: before, previous: before, stale: true });
    expect(await git(["rev-parse", "HEAD"], cache)).toBe(before);
    expect(existsSync(join(cache, "websites/A/One/metadata.json"))).toBe(true);
  });

  test("a source that was never fetched has nothing to fall back on, and leaves nothing behind", async () => {
    const fresh = join(root, "fresh");
    await expect(
      syncSource({ repository: join(root, "nowhere"), branch: "main" }, fresh, log, quiet),
    ).rejects.toThrow("no earlier copy");
    expect(existsSync(fresh)).toBe(false);
  });

  test("a half-made checkout (an interrupted first fetch) is started over", async () => {
    const restored = await commit(origin, { "websites/C/Three/metadata.json": "{}" }, "back");
    const half = join(root, "half");
    await mkdir(half);
    await git(["init", "-q"], half);
    const result = await syncSource({ repository: origin, branch: "main" }, half, log, quiet);
    expect(result).toEqual({ commit: restored, previous: null, stale: false });
  });

  test("a source a local checkout stands in for is never fetched, and offline means no network at all", async () => {
    const before = { ...process.env };
    try {
      process.env[SOURCE_ENV.parousia] = root;
      process.env[SOURCE_ENV.premid] = root;
      const lines: string[] = [];
      expect(await fetchSources((line) => lines.push(line))).toEqual([]);
      expect(lines).toEqual([]);
      delete process.env[SOURCE_ENV.parousia];
      delete process.env[SOURCE_ENV.premid];
      process.env[OFFLINE_ENV] = "1";
      await refreshSources((line) => lines.push(line));
      expect(lines).toEqual([]);
    } finally {
      for (const key of [SOURCE_ENV.parousia, SOURCE_ENV.premid, OFFLINE_ENV]) {
        if (before[key] === undefined) delete process.env[key];
        else process.env[key] = before[key];
      }
    }
  });
});
