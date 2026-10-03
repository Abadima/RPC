import { describe, expect, test } from "bun:test";
import type { PreferenceArea } from "../core/preferences";
import { RELEASES_API, latestDesktopVersion, parseLatestRelease } from "./latest-desktop";

const release = (body: string) => JSON.stringify({ tag_name: "v1.1.0", body });
const MARKER = "<!-- parousia-desktop: 1.0.1 -->";

function memory(
  initial: Record<string, unknown> = {},
): PreferenceArea & { data: Record<string, unknown> } {
  const data = { ...initial };
  return {
    data,
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (items) => void Object.assign(data, items),
  };
}

const answering = (text: string, ok = true) => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Response(text, { status: ok ? 200 : 403 });
  };
  return { fetcher, calls };
};

describe("parseLatestRelease", () => {
  test("reads the Desktop version a release names in its notes", () => {
    expect(parseLatestRelease(release(`Notes\n\n${MARKER}\n`))).toBe("1.0.1");
    expect(parseLatestRelease(release("<!--parousia-desktop:2.10.3-->"))).toBe("2.10.3");
  });

  test("is null for anything that isn't a release naming one", () => {
    for (const text of [
      "",
      "not json",
      "[]",
      "null",
      JSON.stringify({ tag_name: "v1.1.0" }),
      JSON.stringify({ body: 5 }),
      release("no marker here"),
      release("<!-- parousia-desktop: latest -->"),
      release("<!-- parousia-desktop: 1.0 -->"),
      release("<!-- parousia-desktop: 1.0.1-beta -->"),
      release(`${"x".repeat(300_000)}${MARKER}`),
    ]) {
      expect(parseLatestRelease(text)).toBeNull();
    }
  });
});

describe("latestDesktopVersion", () => {
  test("asks GitHub's API for the latest release and remembers the answer for a day", async () => {
    const area = memory();
    const { fetcher, calls } = answering(release(MARKER));
    expect(await latestDesktopVersion({ fetcher, area, now: () => 1_000 })).toBe("1.0.1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(RELEASES_API);
    expect(calls[0]?.url).toStartWith("https://api.github.com/");
    // Nothing that identifies the user or the extension goes with it.
    expect(calls[0]?.init?.credentials).toBe("omit");
    expect(calls[0]?.init?.referrerPolicy).toBe("no-referrer");

    expect(await latestDesktopVersion({ fetcher, area, now: () => 1_000 + 23 * 3_600_000 })).toBe(
      "1.0.1",
    );
    expect(calls).toHaveLength(1);
    expect(await latestDesktopVersion({ fetcher, area, now: () => 1_000 + 25 * 3_600_000 })).toBe(
      "1.0.1",
    );
    expect(calls).toHaveLength(2);
  });

  test("a failed lookup is null, and isn't retried for an hour", async () => {
    const area = memory();
    const failing = answering("rate limited", false);
    expect(await latestDesktopVersion({ fetcher: failing.fetcher, area, now: () => 0 })).toBeNull();
    expect(
      await latestDesktopVersion({ fetcher: failing.fetcher, area, now: () => 30 * 60_000 }),
    ).toBeNull();
    expect(failing.calls).toHaveLength(1);
    const working = answering(release(MARKER));
    expect(
      await latestDesktopVersion({ fetcher: working.fetcher, area, now: () => 61 * 60_000 }),
    ).toBe("1.0.1");
  });

  test("a network error is null too", async () => {
    const fetcher = async (): Promise<Response> => {
      throw new TypeError("offline");
    };
    expect(await latestDesktopVersion({ fetcher, area: memory(), now: () => 0 })).toBeNull();
  });

  test("an unreadable cache is ignored", async () => {
    const area = memory({ latestDesktop: { version: 7, at: "yesterday" } });
    const { fetcher, calls } = answering(release(MARKER));
    expect(await latestDesktopVersion({ fetcher, area, now: () => 5 })).toBe("1.0.1");
    expect(calls).toHaveLength(1);
  });

  test("a failing store doesn't stop the answer", async () => {
    const area: PreferenceArea = {
      get: async () => {
        throw new Error("storage");
      },
      set: async () => {
        throw new Error("storage");
      },
    };
    const { fetcher } = answering(release(MARKER));
    expect(await latestDesktopVersion({ fetcher, area, now: () => 0 })).toBe("1.0.1");
  });
});
