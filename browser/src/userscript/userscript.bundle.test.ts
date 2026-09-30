import { describe, expect, test } from "bun:test";
import { activitiesPlugin } from "../../scripts/activities/plugin";

const bundle = (async () => {
  const result = await Bun.build({
    entrypoints: [new URL("./index.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    minify: true,
    // No Activities: this is about the bundle itself.
    plugins: [activitiesPlugin([])],
  });
  if (!result.success) throw new Error("userscript failed to bundle");
  return result.outputs[0]!.text();
})();

const GLOBALS = ["GM_registerMenuCommand", "document", "window", "WebSocket", "chrome"];

/**
 * Runs the bundled userscript the way a manager would: with the granted GM_*
 * APIs and nothing from the extension runtime.
 */
async function runBundle(): Promise<{
  commands: string[];
  opened: string[];
  listeners: string[];
}> {
  const code = await bundle;
  const commands: string[] = [];
  const opened: string[] = [];
  const listeners: string[] = [];
  const scope = globalThis as Record<string, unknown>;
  const saved = new Map(GLOBALS.map((key) => [key, scope[key]]));
  scope.GM_registerMenuCommand = (caption: string) => commands.push(caption);
  scope.chrome = undefined;
  scope.WebSocket = class {
    constructor(url: string) {
      opened.push(url);
    }
  };
  scope.document = {
    hidden: false,
    title: "Example",
    addEventListener: (type: string) => listeners.push(type),
  };
  scope.window = {
    location: { href: "https://example.com/" },
    addEventListener: (type: string) => listeners.push(type),
  };
  try {
    // Executing the actual bundled output is the point of this test.
    // oxlint-disable-next-line no-eval
    (0, eval)(code);
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    for (const [key, value] of saved) scope[key] = value;
  }
  return { commands, opened, listeners };
}

describe("userscript bundle", () => {
  test("never touches the extension runtime", async () => {
    expect(await bundle).not.toContain("chrome.runtime");
  });

  test("offers a status command, watches navigation, opens no connection while idle", async () => {
    const { commands, opened, listeners } = await runBundle();
    expect(commands).toEqual(["Parousia Desktop status"]);
    expect(opened).toEqual([]);
    expect(listeners).toEqual(
      expect.arrayContaining([
        "popstate",
        "hashchange",
        "visibilitychange",
        "pagehide",
        "pageshow",
      ]),
    );
  });
});
