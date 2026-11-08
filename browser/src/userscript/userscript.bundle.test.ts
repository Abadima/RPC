import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { activitiesPlugin } from "../../scripts/activities/plugin";

const bundle = (async () => {
  const result = await Bun.build({
    entrypoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
    target: "browser",
    format: "esm",
    minify: true,
    define: { USERSCRIPT_VERSION: JSON.stringify("1.0.0") },
    plugins: [activitiesPlugin([])],
  });
  if (!result.success) throw new Error("userscript failed to bundle");
  return result.outputs[0]!.text();
})();

const GLOBALS = [
  "GM_registerMenuCommand",
  "document",
  "window",
  "WebSocket",
  "chrome",
  "MutationObserver",
];

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

describe("userscript on a page an Activity looks at", () => {
  test("watches the title once the page has a <head>, even when it starts before there is one", async () => {
    const dir = await mkdtemp(join(tmpdir(), "userscript-"));
    try {
      const modulePath = join(dir, "example.ts");
      await writeFile(
        modulePath,
        "export default { detect: ({ title }) => ({ id: 'example', name: 'Example', details: title }) };\n",
      );
      const result = await Bun.build({
        entrypoints: [fileURLToPath(new URL("./index.ts", import.meta.url))],
        target: "browser",
        format: "esm",
        define: { USERSCRIPT_VERSION: JSON.stringify("1.0.0") },
        plugins: [
          activitiesPlugin([
            {
              site: "example",
              modulePath,
              manifest: {
                info: {
                  id: "example",
                  name: "Example",
                  hosts: ["example.com"],
                  source: "parousia",
                },
                match: { patterns: ["https://example.com/*"] },
              },
            },
          ]),
        ],
      });
      const code = await result.outputs[0]!.text();
      const observed: unknown[] = [];
      const listeners = new Map<string, () => void>();
      const head = { nodeName: "HEAD" };
      const page = { hidden: false, title: "", head: null as unknown };
      const scope = globalThis as Record<string, unknown>;
      const saved = new Map(GLOBALS.map((key) => [key, scope[key]]));
      scope.GM_registerMenuCommand = () => {};
      scope.chrome = undefined;
      scope.WebSocket = class {
        send(): void {}
        close(): void {}
      };
      scope.MutationObserver = class {
        observe(target: unknown): void {
          // As a browser does: only a node can be watched.
          if (target === null) throw new TypeError("parameter 1 is not of type 'Node'");
          observed.push(target);
        }
        disconnect(): void {}
      };
      scope.document = {
        ...page,
        addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      };
      const windowListeners = new Map<string, () => void>();
      scope.window = {
        location: { href: "https://example.com/watch" },
        addEventListener: (type: string, listener: () => void) =>
          windowListeners.set(type, listener),
      };
      try {
        // Executing the actual bundled output is the point of this test.
        // oxlint-disable-next-line no-eval
        (0, eval)(code);
        expect(observed).toEqual([]);
        Object.assign(scope.document as object, { head, title: "Example - Watch" });
        listeners.get("DOMContentLoaded")?.();
        expect(observed).toEqual([head]);
        windowListeners.get("pagehide")?.();
      } finally {
        for (const [key, value] of saved) scope[key] = value;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
