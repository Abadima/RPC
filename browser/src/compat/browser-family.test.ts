import { afterEach, describe, expect, test } from "bun:test";
import { onFirefox } from "./browser-family";

const original = globalThis.chrome;
const original_browser = Reflect.get(globalThis, "browser");
afterEach(() => {
  globalThis.chrome = original;
  Reflect.set(globalThis, "browser", original_browser);
});

function extensionAt(origin: string): void {
  globalThis.chrome = { runtime: { getURL: (path: string) => `${origin}/${path}` } } as never;
}

describe("onFirefox", () => {
  test("goes by the extension's own address", () => {
    extensionAt("moz-extension://8d7c6b5a-4e3f-4a2b-9c1d-0e1f2a3b4c5d");
    expect(onFirefox()).toBe(true);
    extensionAt("chrome-extension://agnaejlkbiiggajjmnpmeheigkflbnoo");
    expect(onFirefox()).toBe(false);
  });

  test("a `browser` global, which current Chrome has too, says nothing", () => {
    Reflect.set(globalThis, "browser", {});
    extensionAt("chrome-extension://agnaejlkbiiggajjmnpmeheigkflbnoo");
    expect(onFirefox()).toBe(false);
  });
});
