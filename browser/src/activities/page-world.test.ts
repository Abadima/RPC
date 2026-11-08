import { afterEach, describe, expect, test } from "bun:test";
import { readPage } from "./page-world";

const page = globalThis as Record<string, unknown>;
const added = ["player", "ranCode", "evaluate", "window", "document"];

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

  // Reaching an invocation method instead of the evaluator itself is the same
  // escape: `eval.call` resolves to Function.prototype.call, which no identity
  // list holds, and applying it with `eval` as `this` runs the text. The owner
  // is blocked too, so a path that goes *through* an evaluator is refused. (In
  // a browser `window` is the same global the specs are resolved from.)
  test("an evaluator's call/apply/bind is unreachable through its members either way", async () => {
    page.evaluate = Reflect.get(globalThis, "eval");
    page.window = page;
    page.document = {
      write: (text: string): void => {
        page.ranCode = text;
      },
      writeln: (text: string): void => {
        page.ranCode = text;
      },
    };
    for (const [call, args] of [
      ["eval.call", [null, "globalThis.ranCode = true"]],
      ["eval.apply", [null, ["globalThis.ranCode = true"]]],
      ["window.eval.call", [null, "globalThis.ranCode = true"]],
      ["evaluate.call", [null, "globalThis.ranCode = true"]],
      ["Function.call", [null, "globalThis.ranCode = true"]],
      ["document.write.call", [null, "<script>globalThis.ranCode = true</script>"]],
      ["document.writeln.call", [null, "<script>globalThis.ranCode = true</script>"]],
    ] as Array<[string, unknown[]]>) {
      const answer = await readPage({ kind: "exec", call, args }, 1024);
      expect(answer).toBeNull();
    }
    // Creating a bound eval (`eval.bind.call`, `eval.bind`) answers nothing:
    // resolving properties never invokes them, and args are plain JSON.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(page.ranCode).toBeUndefined();
    expect(await readPage({ kind: "exec", call: "eval.bind", args: ["1+1"] }, 1024)).toBeNull();
    expect(
      await readPage({ kind: "exec", call: "eval.bind.call", args: [null, "1+1"] }, 1024),
    ).toBeNull();
  });

  test("a page's own call/apply/bind members still work, as it names them", async () => {
    let ran = "";
    page.player = {
      controls: {
        call: (): string => {
          ran = "call";
          return "pressed";
        },
        apply: (): void => {
          ran = "apply";
        },
        // A sensible page API hands a bound function out; readPage can only
        // answer what serializes, so it makes the call and answers nothing.
        bind: (): (() => void) => {
          ran = "bind";
          return () => {};
        },
      },
    };
    expect(await readPage({ kind: "exec", call: "player.controls.call" }, 1024)).toBe(
      JSON.stringify("pressed"),
    );
    expect(await readPage({ kind: "exec", call: "player.controls.apply" }, 1024)).toBeNull();
    expect(await readPage({ kind: "exec", call: "player.controls.bind" }, 1024)).toBeNull();
    expect(ran).toBe("bind");
  });

  test("answers nothing larger than it's allowed", async () => {
    page.player = { title: "x".repeat(100) };
    expect(await readPage({ kind: "exec", get: "player.title" }, 50)).toBeNull();
  });
});
