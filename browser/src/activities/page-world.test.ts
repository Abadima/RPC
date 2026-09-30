import { afterEach, describe, expect, test } from "bun:test";
import { readPage } from "./page-world";

const page = globalThis as Record<string, unknown>;
const added = ["player", "ranCode", "evaluate"];

afterEach(() => {
  for (const key of added) Reflect.deleteProperty(page, key);
});

describe("readPage, run in the page's own world", () => {
  test("reads the page's variables and calls its functions, answering JSON", async () => {
    page.player = { title: "Song", volume: 3, track: () => ({ id: 7, secret: "x" }) };
    expect(
      await readPage({ kind: "variables", paths: ["player.title", "player.missing"] }, 1024),
    ).toBe(JSON.stringify({ "player.title": "Song" }));
    expect(await readPage({ kind: "exec", get: "player.volume" }, 1024)).toBe("3");
    expect(await readPage({ kind: "exec", call: "player.track", pick: ["id"] }, 1024)).toBe(
      JSON.stringify({ id: 7 }),
    );
    expect(await readPage({ kind: "exec", call: "player.track", omit: ["secret"] }, 1024)).toBe(
      JSON.stringify({ id: 7 }),
    );
  });

  test("never calls something that runs text as code, however the page names it", async () => {
    page.evaluate = Reflect.get(globalThis, "eval");
    for (const call of ["eval", "evaluate", "Function", "setTimeout", "setInterval"]) {
      expect(
        await readPage({ kind: "exec", call, args: ["globalThis.ranCode = true", 0] }, 1024),
      ).toBeNull();
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(page.ranCode).toBeUndefined();
  });

  test("answers nothing larger than it's allowed", async () => {
    page.player = { title: "x".repeat(100) };
    expect(await readPage({ kind: "exec", get: "player.title" }, 50)).toBeNull();
  });
});
