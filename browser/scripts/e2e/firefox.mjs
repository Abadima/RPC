// Drives an installed Firefox over WebDriver BiDi (built into Firefox; JSON
// over a WebSocket, so no driver binary or patched browser is needed) with
// a throwaway profile. `-no-remote` and a separate profile keep it apart
// from any Firefox the user already has open.
//
// Extensions are installed permanently by dropping their XPI in the
// profile's extensions directory, with their moz-extension UUIDs fixed
// through `extensions.webextensions.uuids` so their origins are known in
// advance. Unsigned XPIs (Parousia's own build) only load where signature
// checks can be turned off: Developer Edition, Nightly, or unbranded builds.

import { spawn } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STATUS_LINE, STEP_TIMEOUT_MS, sleep, track, waitUntil } from "./lib.mjs";

export const FIREFOX_BINARY = process.env.FIREFOX_BIN ?? "/opt/firefox/firefox";

/** Prepares a profile with `extensions`: [{ id, xpi, uuid }]. */
export async function prepareProfile(profileDir, extensions) {
  await mkdir(join(profileDir, "extensions"), { recursive: true });
  for (const extension of extensions) {
    await copyFile(extension.xpi, join(profileDir, "extensions", `${extension.id}.xpi`));
  }
  const uuids = Object.fromEntries(extensions.map((extension) => [extension.id, extension.uuid]));
  const prefs = {
    "xpinstall.signatures.required": false,
    "extensions.autoDisableScopes": 0,
    "extensions.enabledScopes": 15,
    "extensions.webextensions.uuids": JSON.stringify(uuids),
    "browser.shell.checkDefaultBrowser": false,
    "browser.startup.homepage_override.mstone": "ignore",
    "datareporting.policy.dataSubmissionEnabled": false,
    "toolkit.telemetry.reportingpolicy.firstRun": false,
    "app.update.enabled": false,
    "extensions.update.enabled": false,
  };
  await writeFile(
    join(profileDir, "user.js"),
    Object.entries(prefs)
      .map(([key, value]) => `user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`)
      .join("\n"),
  );
}

export async function launchFirefox({ profileDir, env, port = 9444 }) {
  const child = track(
    spawn(
      FIREFOX_BINARY,
      [
        "--headless",
        "--no-remote",
        "--profile",
        profileDir,
        "--remote-debugging-port",
        String(port),
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    ),
  );
  let output = "";
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Firefox never started BiDi:\n${output}`)),
      STEP_TIMEOUT_MS,
    );
    child.stderr.on("data", (chunk) => {
      output += chunk;
      const match = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.once("exit", () => reject(new Error(`Firefox exited early:\n${output}`)));
  });

  const socket = new WebSocket(`${url}/session`);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = () => reject(new Error("BiDi connection failed"));
  });
  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.type === "error") reject(new Error(`${message.error}: ${message.message}`));
      else resolve(message.result);
    } else if (message.method) {
      for (const listener of listeners) listener(message);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send("session.new", {
    capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: "ignore" } } },
  });
  await send("session.subscribe", { events: ["browsingContext.userPromptOpened"] });

  const firefox = {
    send,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async contexts() {
      return (await send("browsingContext.getTree", {})).contexts;
    },
    /** A new tab; `background` keeps the current one active. */
    async openTab(url, { background = false } = {}) {
      const { context } = await send("browsingContext.create", { type: "tab", background });
      await send("browsingContext.navigate", { context, url, wait: "complete" });
      return context;
    },
    async navigate(context, url) {
      await send("browsingContext.navigate", { context, url, wait: "complete" });
    },
    /** Makes `context` its window's active tab. */
    async activate(context) {
      await send("browsingContext.activate", { context });
    },
    async closeTab(context) {
      await send("browsingContext.close", { context });
    },
    /** Evaluates `expression` in the page and returns its (JSON-able) value. */
    async evaluate(context, expression) {
      const result = await send("script.evaluate", {
        expression: `(async () => JSON.stringify(await (async () => (${expression}))()))()`,
        target: { context },
        awaitPromise: true,
      });
      if (result.type === "exception") throw new Error(`in page: ${result.exceptionDetails.text}`);
      return result.result.value === undefined ? undefined : JSON.parse(result.result.value);
    },
    /**
     * Resolves with the next prompt/alert opened anywhere, after answering it
     * (`text` for a prompt).
     */
    nextPrompt(text) {
      const next = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          stop();
          reject(new Error("no prompt appeared"));
        }, STEP_TIMEOUT_MS);
        const stop = firefox.onEvent(async (event) => {
          if (event.method !== "browsingContext.userPromptOpened") return;
          stop();
          clearTimeout(timer);
          const { context, type, message } = event.params;
          await send("browsingContext.handleUserPrompt", {
            context,
            accept: true,
            ...(type === "prompt" && text !== undefined ? { userText: text } : {}),
          });
          resolve({ type, message });
        });
      });
      // Usually created before the action that opens the prompt and awaited
      // after it; a timeout in between is reported there, not as a crash.
      next.catch(() => {});
      return next;
    },
    async close() {
      // Closing ends the session, so a reply may never arrive.
      await Promise.race([send("browser.close", {}).catch(() => {}), sleep(5000)]);
      socket.close();
      if (child.exitCode === null) {
        await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(10_000)]);
        child.kill();
      }
    },
  };
  return firefox;
}

/** Popup helpers over BiDi, mirroring lib.mjs's Playwright ones. */
export const firefoxPopup = {
  status: (firefox, context) => firefox.evaluate(context, STATUS_LINE),

  waitForStatus(firefox, context, pattern, timeoutMs = STEP_TIMEOUT_MS) {
    return waitUntil(
      async () => {
        const text = await firefoxPopup.status(firefox, context);
        return pattern.test(text ?? "") ? text : false;
      },
      `Firefox popup status ${pattern}`,
      timeoutMs,
    );
  },

  /**
   * Leaves and reloads the page in `context`: its port to the background
   * closes and a new one opens, which makes the background check again.
   */
  async reopen(firefox, context) {
    const url = await firefox.evaluate(context, "location.href");
    await firefox.navigate(context, "about:blank");
    await firefox.navigate(context, url);
  },

  /** The "what to do about it" line, or null while it's hidden. */
  help: (firefox, context) =>
    firefox.evaluate(
      context,
      `(() => { const el = document.getElementById("connection-help"); return el.hidden ? null : el.textContent; })()`,
    ),
};
