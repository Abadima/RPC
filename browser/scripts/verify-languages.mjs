// End-to-end check of the languages (Settings > General) in playwright-core's
// Chromium, on the extension as built in dist/chromium. No Desktop is needed:
// pages show their not-connected states, which is enough to show their words.
//
// Covers:
// - Each language in the popup and the dashboard: the page's own text, text
//   built by the code, a plural, and the page's `lang`, with no page errors.
// - Automatic follows the browser's own language (a French browser),
//   and English where the browser's isn't one of ours.
// - A change of language in one view reloads another open one.
// - A PreMiD Activity's description in the chosen language, where PreMiD has one.
//
// Needs `bun run build` first (it reads PAROUSIA_BUILD_DIR, default dist).

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";
import { QUIET_DISCORD, assert, browserDir, logger, waitUntil } from "./e2e/lib.mjs";
import { EXPECTED } from "./e2e/languages.mjs";

const log = logger("languages");
const extensionDir = resolve(browserDir, process.env.PAROUSIA_BUILD_DIR ?? "dist", "chromium");

/**
 * `locale` is the browser's own language (`fr_FR`). Chromium on Linux takes
 * it from the environment, not from `--lang`.
 */
async function launch(locale) {
  const userData = await mkdtemp(join(tmpdir(), "lang-"));
  const context = await chromium.launchPersistentContext(userData, {
    headless: false,
    env: { ...process.env, LANGUAGE: locale, LC_ALL: `${locale}.UTF-8` },
    args: [
      "--headless=new",
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      "--no-sandbox",
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  await worker.evaluate(QUIET_DISCORD);
  const choose = (language) =>
    worker.evaluate(
      (language) =>
        chrome.storage.local.set({ preferences: { language, discordRpcExtension: false } }),
      language,
    );
  return {
    context,
    id,
    choose,
    close: () => context.close().then(() => rm(userData, { recursive: true, force: true })),
  };
}

/** The popup and the dashboard in a language: what they show, and any page error. `settled` is the footer once Desktop's absence is known. */
async function look({ context, id }, settled) {
  const errors = [];
  const popup = await context.newPage();
  popup.on("pageerror", (error) => errors.push(String(error)));
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForSelector("#status-label");
  // The footer follows the connection, which starts out trying: wait for it to settle.
  const home = await waitUntil(async () => {
    const seen = await popup.evaluate(() => ({
      lang: document.documentElement.lang,
      footer: document.getElementById("status-label").textContent,
    }));
    return seen.footer === settled ? seen : false;
  }, `the popup's footer to read "${settled}"`);
  await popup.click("#settings-button");
  const settings = await popup.evaluate(() =>
    [...document.querySelectorAll(".category .row-title")].map((element) => element.textContent),
  );
  await popup.close();

  const dashboard = await context.newPage();
  dashboard.on("pageerror", (error) => errors.push(String(error)));
  await dashboard.goto(`chrome-extension://${id}/fullscreen.html#activities`);
  await dashboard.waitForSelector(".activity-card", { timeout: 20_000 });
  const shown = await dashboard.evaluate(() => ({
    nav: [...document.querySelectorAll(".nav-link")].map((element) => element.textContent.trim()),
    summary: document.querySelector('[data-slot="summary"]').textContent,
  }));
  await dashboard.close();
  return { home, settings, ...shown, errors };
}

{
  {
    const browser = await launch("en_US");
    try {
      for (const [language, expected] of Object.entries(EXPECTED)) {
        await browser.choose(language);
        const seen = await look(browser, expected.footer);
        assert(seen.errors.length === 0, `${language}: page errors ${seen.errors.join("; ")}`);
        assert(seen.home.lang === language, `${language}: <html lang> is ${seen.home.lang}`);
        assert(seen.home.footer === expected.footer, `${language}: footer is ${seen.home.footer}`);
        assert(
          expected.settings.every((word, i) => seen.settings[i] === word),
          `${language}: settings are ${seen.settings}`,
        );
        assert(
          expected.nav.every((word, i) => seen.nav[i] === word),
          `${language}: navigation is ${seen.nav}`,
        );
        assert(expected.summary.test(seen.summary), `${language}: summary is ${seen.summary}`);
        log(`${language}: popup and dashboard are in it`);
      }

      await browser.choose("auto");
      assert(
        (await look(browser, EXPECTED.en.footer)).home.lang === "en",
        "automatic: an English browser gets English",
      );
      log("automatic: an English browser gets English");

      // A change in one view reaches another that's open.
      await browser.choose("en");
      const open = await browser.context.newPage();
      await open.goto(`chrome-extension://${browser.id}/fullscreen.html#settings/general`);
      await open.waitForSelector(".settings-pane-title");
      assert((await open.textContent(".settings-pane-title")) === "General", "General, in English");
      await browser.choose("fr");
      await waitUntil(
        async () => (await open.textContent(".settings-pane-title").catch(() => "")) === "Général",
        "the open dashboard reloading in French",
      );
      log("a change of language reloads another open view");

      // A PreMiD Activity's description: PreMiD's own where it has one, in each language that has them.
      for (const [language, title] of [
        ["fr", "Général"],
        ["de", "Allgemein"],
      ]) {
        await browser.choose(language);
        await waitUntil(
          async () => (await open.textContent(".settings-pane-title").catch(() => "")) === title,
          `the open dashboard reloading in ${language}`,
        );
        const translated = JSON.parse(
          await readFile(
            join(extensionDir, "activities", "descriptions", `${language}.json`),
            "utf8",
          ),
        );
        const [[activity, description]] = Object.entries(translated);
        await open.goto(
          `chrome-extension://${browser.id}/fullscreen.html#activities/${encodeURIComponent(activity)}`,
        );
        await waitUntil(
          async () =>
            (await open.textContent('[data-slot="description"]').catch(() => "")) === description,
          `${activity}'s description in ${language}`,
        );
        await open.goto(`chrome-extension://${browser.id}/fullscreen.html#settings/general`);
      }
      log("a PreMiD Activity's description is in the chosen language where PreMiD has one");
      await open.close();
    } finally {
      await browser.close();
    }
  }

  {
    // Automatic follows the browser: French and German here, and a language we don't have gets English.
    for (const [locale, expected] of [
      ["fr_FR", "fr"],
      ["de_DE", "de"],
      ["es_ES", "en"],
    ]) {
      const browser = await launch(locale);
      try {
        const seen = await look(browser, EXPECTED[expected].footer);
        assert(
          seen.home.lang === expected,
          `a ${locale} browser on automatic gets ${seen.home.lang}`,
        );
        assert(seen.errors.length === 0, `${locale}: page errors ${seen.errors.join("; ")}`);
      } finally {
        await browser.close();
      }
      log(`automatic: a ${locale} browser gets ${expected}`);
    }
  }
  console.log("[languages] ok");
}
